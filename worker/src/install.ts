// One-line installers served at /i/<code> (docs/dev/PLAN.md §3.2). They download the agent from GitHub
// Releases, verify its SHA-256 against checksums.txt, then run `devicetally enroll`.

const SH = `#!/bin/sh
# DeviceTally agent installer. Source: your DeviceTally server.
set -eu
SERVER="__SERVER__"; CODE="__CODE__"
os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$os" in darwin|linux) ;; *) echo "Unsupported OS: $os" >&2; exit 1 ;; esac
arch=$(uname -m)
case "$arch" in x86_64|amd64) arch=amd64 ;; arm64|aarch64) arch=arm64 ;; *) echo "Unsupported CPU: $arch" >&2; exit 1 ;; esac
asset="devicetally_\${os}_\${arch}"
base="$SERVER/dl"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
if ! curl -fsSL "$base/$asset" -o "$tmp/devicetally"; then
  echo "Could not download the agent from your DeviceTally server. Check your connection and try again." >&2
  exit 1
fi
curl -fsSL "$base/checksums.txt" -o "$tmp/checksums.txt"
want=$(awk -v a="$asset" '$2 == a { print $1 }' "$tmp/checksums.txt")
if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$tmp/devicetally" | awk '{print $1}')
else got=$(shasum -a 256 "$tmp/devicetally" | awk '{print $1}'); fi
if [ -z "$want" ] || [ "$want" != "$got" ]; then echo "Checksum mismatch: not installing." >&2; exit 1; fi
chmod +x "$tmp/devicetally"
# Read answers from the terminal even though this script arrives through a pipe.
if [ -r /dev/tty ]; then "$tmp/devicetally" enroll "$SERVER" "$CODE" </dev/tty; else "$tmp/devicetally" enroll "$SERVER" "$CODE"; fi
`

const PS1 = `# DeviceTally agent installer. Source: your DeviceTally server.
$ErrorActionPreference = 'Stop'
$server = '__SERVER__'; $code = '__CODE__'
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'amd64' }
$asset = "devicetally_windows_$arch.exe"
$base = "$server/dl"
$tmp = Join-Path $env:TEMP ('devicetally-' + [guid]::NewGuid())
New-Item -ItemType Directory $tmp | Out-Null
try {
  $exe = Join-Path $tmp 'devicetally.exe'
  Invoke-WebRequest "$base/$asset" -OutFile $exe -UseBasicParsing
  $sums = (Invoke-WebRequest "$base/checksums.txt" -UseBasicParsing).Content
  if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
  $want = $sums -split "\`n" | ForEach-Object { $p = $_.Trim() -split '\\s+'; if ($p[1] -eq $asset) { $p[0] } } | Select-Object -First 1
  $got = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()
  if (-not $want -or $want -ne $got) { throw 'Checksum mismatch: not installing.' }
  & $exe enroll $server $code
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
`

const CODE = /^[2-9A-HJKMNP-Z]{6}$/

// Cloudflare's edge cache; outside Cloudflare (Node) there is none, so downloads go to GitHub/npm each time.
const none = { match: async () => undefined, put: async () => {} } as unknown as Cache
const cache = () => (typeof caches === 'undefined' ? none : (caches as unknown as { default: Cache }).default)
const ASSET = /^(devicetally_(darwin|linux|windows)_(amd64|arm64)(\.exe)?|checksums\.txt|DeviceTally_(aarch64|x64)\.app\.tar\.gz|DeviceTally_amd64\.AppImage)$/

/** Latest release tag of `repo`, cached for 5 minutes (null if none is public). */
export async function latestTag(repo: string) {
  const key = new Request(`https://devicetally.internal/latest-tag-v2/${repo}`)
  const hit = await cache().match(key)
  if (hit) return (await hit.text()) || null
  // The releases page redirects to the latest tag. GitHub's API is avoided on purpose: Workers share
  // IP addresses, and its 60 requests/hour unauthenticated limit was found exhausted (2026-10-03).
  const res = await fetch(`https://github.com/${repo}/releases/latest`, { redirect: 'manual' }).catch(() => null)
  const tag = res?.headers.get('location')?.match(/\/releases\/tag\/([^/?#]+)$/)?.[1] ?? ''
  await cache().put(key, new Response(tag, { headers: { 'cache-control': `max-age=${tag ? 300 : 30}` } }))
  return tag || null
}

/**
 * Serves agent downloads from Cloudflare: fetched once from GitHub Releases, then cached at the edge.
 * Measured 2026-10-03: GitHub's download servers took over 2 minutes for 9 MB on the owner's network;
 * Cloudflare took 4 seconds. The cache key includes the release tag, so a binary and its checksums
 * always come from the same release.
 */
export async function download(name: string, repo: string | undefined, ctx: { waitUntil(p: Promise<unknown>): void }) {
  if (!repo || !ASSET.test(name)) return new Response('Not found\n', { status: 404 })
  const tag = await latestTag(repo)
  if (!tag) return new Response('No public release\n', { status: 404 })
  const key = new Request(`https://devicetally.internal/dl/${repo}/${tag}/${name}`)
  const hit = await cache().match(key)
  if (hit) return hit
  // The AppImage's release name carries the version; scripts ask for a stable name.
  const file = name === 'DeviceTally_amd64.AppImage' ? `DeviceTally_${tag.replace(/^v/, '')}_amd64.AppImage` : name
  const upstream = await fetch(`https://github.com/${repo}/releases/download/${tag}/${file}`, { redirect: 'follow' })
  if (!upstream.ok) return new Response('Download failed\n', { status: 502 })
  const res = new Response(upstream.body, {
    headers: { 'content-type': 'application/octet-stream', 'cache-control': 'public, max-age=86400', 'x-devicetally-release': tag },
  })
  ctx.waitUntil(cache().put(key, res.clone()))
  return res
}

const TOKSCALE_PKG = /^cli-(darwin-arm64|darwin-x64|linux-x64-gnu|linux-arm64-gnu|linux-x64-musl|linux-arm64-musl|win32-x64-msvc|win32-arm64-msvc)$/
const SEMVER = /^\d+\.\d+\.\d+$/

/**
 * tokscale (reads other AI tools' logs) from npm, edge-cached like the agent. The agent asks for an
 * exact version and checks npm's sha512 integrity it has pinned, so this route cannot change what runs.
 */
export async function tokscaleDownload(version: string, pkg: string, ctx: { waitUntil(p: Promise<unknown>): void }) {
  if (!SEMVER.test(version) || !TOKSCALE_PKG.test(pkg)) return new Response('Not found\n', { status: 404 })
  const url = `https://registry.npmjs.org/@tokscale/${pkg}/-/${pkg}-${version}.tgz`
  const key = new Request(`https://devicetally.internal/tokscale/${version}/${pkg}`)
  const hit = await cache().match(key)
  if (hit) return hit
  const upstream = await fetch(url)
  if (!upstream.ok) return new Response('Download failed\n', { status: 502 })
  const res = new Response(upstream.body, { headers: { 'content-type': 'application/gzip', 'cache-control': 'public, max-age=31536000, immutable' } })
  ctx.waitUntil(cache().put(key, res.clone()))
  return res
}

// The app installer: `curl -fsSL <server>/app | sh`. Files fetched with curl carry no quarantine mark,
// so macOS does not show "DeviceTally is damaged" for the unsigned app (no paid Apple certificate).
const APP_SH = `#!/bin/sh
# DeviceTally app installer. Source: your DeviceTally server.
set -eu
SERVER="__SERVER__"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
case "$(uname -s)" in
  Darwin)
    case "$(uname -m)" in arm64) asset=DeviceTally_aarch64.app.tar.gz ;; *) asset=DeviceTally_x64.app.tar.gz ;; esac
    curl -fsSL "$SERVER/dl/$asset" -o "$tmp/app.tgz" || { echo "Could not download the app from your DeviceTally server." >&2; exit 1; }
    tar -xzf "$tmp/app.tgz" -C "$tmp"
    pkill -f "DeviceTally.app/Contents/MacOS" 2>/dev/null || true
    dest=/Applications; [ -w "$dest" ] || dest="$HOME/Applications"; mkdir -p "$dest"
    rm -rf "$dest/DeviceTally.app"; mv "$tmp/DeviceTally.app" "$dest/"
    open "$dest/DeviceTally.app"
    echo "✓ DeviceTally is installed in $dest and running in your menu bar." ;;
  Linux)
    [ "$(uname -m)" = x86_64 ] || { echo "The Linux app is available for x86_64 only." >&2; exit 1; }
    mkdir -p "$HOME/.local/bin"
    curl -fsSL "$SERVER/dl/DeviceTally_amd64.AppImage" -o "$HOME/.local/bin/DeviceTally.AppImage" || { echo "Could not download the app." >&2; exit 1; }
    chmod +x "$HOME/.local/bin/DeviceTally.AppImage"
    (nohup "$HOME/.local/bin/DeviceTally.AppImage" >/dev/null 2>&1 &)
    echo "✓ DeviceTally is installed in ~/.local/bin and running in your tray." ;;
  *) echo "On Windows, download the installer from the releases page." >&2; exit 1 ;;
esac
`

export function appScript(url: string) {
  return new Response(APP_SH.replace('__SERVER__', new URL(url).origin), { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
}

/** Whether agents can be downloaded (a private repo has no public release). Same lookup as downloads. */
export async function releaseAvailable(repo: string | undefined) {
  return !!repo && !!(await latestTag(repo))
}

export function installScript(url: string, userAgent: string, repo: string | undefined) {
  const u = new URL(url)
  const m = u.pathname.match(/^\/i\/([^/.]+)(\.ps1|\.sh)?$/)
  const code = m?.[1].toUpperCase()
  if (!code || !CODE.test(code)) return new Response('Not found\n', { status: 404 })
  if (!repo) return new Response('echo "This DeviceTally server has no RELEASE_REPO set, so there is no agent to download." >&2; exit 1\n', { status: 503 })
  const windows = m![2] === '.ps1' || (!m![2] && /PowerShell/i.test(userAgent))
  const body = (windows ? PS1 : SH).replace('__SERVER__', u.origin).replace('__CODE__', code)
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
}
