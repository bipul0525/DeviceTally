// First run (docs/dev/PLAN-onboarding.md): one question, then only the steps that path needs.
// The same three paths exist in the terminal; whichever is used, the app ends up in the same state.
import { DockToggle } from './updates'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { openUrl } from '@tauri-apps/plugin-opener'
import { useEffect, useState } from 'preact/hooks'

// Cloudflare's token page with exactly the permissions DeviceTally needs, pre-filled.
export const TOKEN_URL = 'https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=' + encodeURIComponent(JSON.stringify([
  { key: 'workers_scripts', type: 'edit' }, { key: 'd1', type: 'edit' }, { key: 'account_settings', type: 'read' },
])) + '&name=DeviceTally&accountId=*&zoneId=all'

/** A link that opens in the browser, plus the address with a Copy button for when it doesn't open
 *  (or to paste it into a different browser, the one where you're signed in to Cloudflare). */
export function OpenLink({ url, label, primary }: { url: string; label: string; primary?: boolean }) {
  const [copied, setCopied] = useState(false)
  const [failed, setFailed] = useState(false)
  return (
    <span class="open-link">
      <button type="button" class={primary ? 'btn primary' : 'btn'} onClick={() => openUrl(url).catch(() => setFailed(true))}>{label}</button>
      <span class="hint" style={{ margin: 0 }}>{failed ? 'Could not open the browser.' : 'Didn’t open?'} Copy the link and paste it into the browser where you’re signed in to Cloudflare:</span>
      <span class="cmd"><code>{url}</code><button type="button" class="btn" onClick={() => navigator.clipboard.writeText(url).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy link'}</button></span>
    </span>
  )
}

const defaultName = navigator.userAgent.includes('Mac') ? 'My Mac' : navigator.userAgent.includes('Windows') ? 'My PC' : 'My computer'
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone

function Step({ n, title, children }: { n: number; title: string; children: preact.ComponentChildren }) {
  return (
    <div class="ob-step">
      <span class="ob-n" aria-hidden="true">{n}</span>
      <div><strong>{title}</strong><div class="ob-body">{children}</div></div>
    </div>
  )
}

function Setup({ back, done }: { back: () => void; done: () => void }) {
  const [stage, setStage] = useState<'intro' | 'token' | 'working' | 'admin' | 'finishing'>('intro')
  const [token, setToken] = useState('')
  const [log, setLog] = useState<string[]>([])
  const [err, setErr] = useState('')
  const [server, setServer] = useState({ url: '', setup: '' })
  const [f, setF] = useState({ email: '', password: '', name: defaultName })

  useEffect(() => {
    const un = listen<string>('setup-progress', (e) => setLog((l) => [...l, e.payload]))
    return () => { un.then((f) => f()) }
  }, [])

  const create = async (e: Event) => {
    e.preventDefault()
    setErr(''); setLog([]); setStage('working')
    try {
      const r = await invoke<{ exists: boolean; server: string; setup_token?: string }>('create_server', { cfToken: token })
      if (r.exists) {
        setErr(`A DeviceTally server already exists in this Cloudflare account: ${r.server}. Go back and choose "Sign in as admin".`)
        setStage('token')
        return
      }
      setServer({ url: r.server, setup: r.setup_token! })
      setToken('') // not kept
      setStage('admin')
    } catch (x) {
      setErr(String(x)); setStage('token')
    }
  }

  const finish = async (e: Event) => {
    e.preventDefault()
    setErr(''); setStage('finishing')
    try {
      await invoke('create_admin', { server: server.url, token: server.setup, email: f.email, password: f.password, timezone: tz })
      await invoke('add_this_device', { name: f.name })
      done()
    } catch (x) {
      setErr(String(x)); setStage('admin')
    }
  }

  return (
    <div class="ob">
      <button class="link-btn" onClick={back}>‹ Back</button>
      <h1>Set up DeviceTally</h1>
      {stage === 'intro' && (
        <>
          <p>DeviceTally keeps your usage in <b>your own free Cloudflare account</b>, so nobody else has your data. The app creates everything there for you; this takes about 3 minutes.</p>
          <Step n={1} title="A Cloudflare account">
            Free, no card needed. Create one if you don't have one yet, and verify your email.
            <OpenLink url="https://dash.cloudflare.com/sign-up" label="Create a free Cloudflare account" />
          </Step>
          <div class="actions"><button class="btn primary" onClick={() => setStage('token')}>I have a Cloudflare account</button></div>
        </>
      )}
      {(stage === 'token' || stage === 'working') && (
        <form onSubmit={create}>
          <Step n={2} title="Let DeviceTally create your server">
            <ol class="ob-list">
              <li>Open Cloudflare's token page (sign in if asked). The right permissions are already filled in.<OpenLink url={TOKEN_URL} label="Open Cloudflare's token page" /></li>
              <li>Scroll down and click <b>Continue to summary</b>, then <b>Create Token</b>.</li>
              <li>Click <b>Copy</b> and paste the token here:</li>
            </ol>
            <input class="ob-input" type="password" aria-label="Cloudflare token" placeholder="Paste the token" required value={token} onInput={(e) => setToken(e.currentTarget.value)} disabled={stage === 'working'} />
            <p class="hint">Used once to create your server, then forgotten. You can delete it in Cloudflare afterwards.</p>
          </Step>
          {stage === 'working' ? (
            <ul class="ob-progress" aria-live="polite">{log.map((l, i) => <li key={i}>{i < log.length - 1 ? '✓' : '…'} {l}</li>)}</ul>
          ) : (
            <div class="actions"><button class="btn primary" disabled={!token.trim()}>Create my server</button></div>
          )}
        </form>
      )}
      {(stage === 'admin' || stage === 'finishing') && (
        <form onSubmit={finish}>
          <p>✓ Your server is ready at <b>{server.url.replace('https://', '')}</b>.</p>
          <Step n={3} title="Your admin login">
            You'll use this to manage DeviceTally from any computer.
            <div class="group" style={{ marginTop: 8 }}>
              <div class="field"><label for="ae">Email</label><input id="ae" type="email" required placeholder="you@example.com" value={f.email} onInput={(e) => setF({ ...f, email: e.currentTarget.value })} /></div>
              <div class="field"><label for="ap">Password</label><input id="ap" type="password" required minLength={10} placeholder="At least 10 characters" value={f.password} onInput={(e) => setF({ ...f, password: e.currentTarget.value })} /></div>
              <div class="field"><label for="an">This computer's name</label><input id="an" type="text" required value={f.name} onInput={(e) => setF({ ...f, name: e.currentTarget.value })} /></div>
            </div>
          </Step>
          <div class="actions"><button class="btn primary" disabled={stage === 'finishing'}>{stage === 'finishing' ? 'Connecting this computer…' : 'Finish'}</button></div>
        </form>
      )}
      {err && <p class="err" role="alert">{err}</p>}
    </div>
  )
}

function Join({ back, done }: { back: () => void; done: () => void }) {
  const [f, setF] = useState({ server: '', code: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const join = async (e: Event) => {
    e.preventDefault(); setBusy(true); setErr('')
    try { await invoke('connect_with_code', f); done() } catch (x) { setErr(String(x)) } finally { setBusy(false) }
  }
  return (
    <form class="ob" onSubmit={join}>
      <button type="button" class="link-btn" onClick={back}>‹ Back</button>
      <h1>Join with a code</h1>
      <p>On the computer where DeviceTally is set up, open <b>Devices → Add device</b>. It shows a server address and a 6-letter code (valid 15 minutes).</p>
      <div class="group">
        <div class="field"><label for="js">Server address</label><input id="js" type="text" required placeholder="Paste the server address" value={f.server} onInput={(e) => setF({ ...f, server: e.currentTarget.value })} /></div>
        <div class="field"><label for="jc">Code</label><input id="jc" type="text" required maxLength={6} placeholder="6 letters" value={f.code} onInput={(e) => setF({ ...f, code: e.currentTarget.value.toUpperCase() })} /></div>
      </div>
      <p class="hint">This computer's usage is then tracked in the background. Here you'll see its own token usage.</p>
      <div class="actions"><button class="btn primary" disabled={busy}>{busy ? 'Connecting…' : 'Connect'}</button></div>
      {err && <p class="err" role="alert">{err}</p>}
    </form>
  )
}

export function SignIn({ back, done }: { back: () => void; done: () => void }) {
  const [f, setF] = useState({ server: '', email: '', password: '', token: '' })
  const [first, setFirst] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const go = async (e: Event) => {
    e.preventDefault(); setBusy(true); setErr('')
    try {
      // A new server (npm run setup, or Docker/Node) has no admin yet: create it with the setup token first.
      if (first) await invoke('create_admin', { server: f.server, token: f.token, email: f.email, password: f.password, timezone: tz })
      else await invoke('sign_in', { server: f.server, email: f.email, password: f.password })
      done()
    } catch (x) { setErr(String(x)) } finally { setBusy(false) }
  }
  return (
    <form class="ob" onSubmit={go}>
      <button type="button" class="link-btn" onClick={back}>‹ Back</button>
      <h1>Sign in as admin</h1>
      <p>Manage your DeviceTally from this computer too.</p>
      <div class="group">
        <div class="field"><label for="ss">Server address</label><input id="ss" type="text" required placeholder="https://devicetally.you.workers.dev" value={f.server} onInput={(e) => setF({ ...f, server: e.currentTarget.value })} /></div>
        <div class="field"><label for="se">Email</label><input id="se" type="email" required placeholder="you@example.com" autoComplete="username" value={f.email} onInput={(e) => setF({ ...f, email: e.currentTarget.value })} /></div>
        <div class="field"><label for="sp">Password</label><input id="sp" type="password" required minLength={first ? 10 : 1} autoComplete="current-password" placeholder={first ? 'Choose one, at least 10 characters' : 'Your admin password'} value={f.password} onInput={(e) => setF({ ...f, password: e.currentTarget.value })} /></div>
        <div class="field"><label for="sf">First time on this server (no admin yet)</label><input id="sf" type="checkbox" checked={first} onChange={(e) => setFirst(e.currentTarget.checked)} /></div>
        {first && <div class="field"><label for="st">Setup token</label><input id="st" type="password" required placeholder="Printed by npm run setup or the server's log" value={f.token} onInput={(e) => setF({ ...f, token: e.currentTarget.value })} /></div>}
      </div>
      <p class="hint">Forgot the address? It's in your Cloudflare account under Workers &amp; Pages → devicetally.</p>
      <div class="actions"><button class="btn primary" disabled={busy}>{busy ? 'Signing in…' : first ? 'Create admin login' : 'Sign in'}</button></div>
      {err && <p class="err" role="alert">{err}</p>}
    </form>
  )
}

export function Onboarding({ done: finished }: { done: () => void }) {
  // Set up or joined: open at login from now on (Settings can turn it off).
  const done = () => {
    try { localStorage.setItem('dt-autostart-default', '1') } catch { /* fine */ }
    import('@tauri-apps/plugin-autostart').then((m) => m.enable()).catch(() => {})
    finished()
  }
  const [path, setPath] = useState<'choose' | 'setup' | 'join' | 'signin'>('choose')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  if (path === 'setup') return <Setup back={() => setPath('choose')} done={done} />
  if (path === 'join') return <Join back={() => setPath('choose')} done={done} />
  if (path === 'signin') return <SignIn back={() => setPath('choose')} done={done} />
  return (
    <div class="ob">
      <h1>Welcome to DeviceTally</h1>
      <p>One menu-bar app for all your computers: AI coding usage, agent status, system stats and storage.</p>
      <div class="ob-cards">
        <button class="ob-card" onClick={() => setPath('setup')}>
          <strong>Set up DeviceTally</strong><span>First time. Creates your private server in a free Cloudflare account and makes this computer the admin.</span>
        </button>
        <button class="ob-card" onClick={() => setPath('join')}>
          <strong>Join with a code</strong><span>DeviceTally is already set up on another computer, and you have a code from it.</span>
        </button>
        <button class="ob-card" onClick={() => setPath('signin')}>
          <strong>Sign in as admin</strong><span>You already have a server and want to manage it from here.</span>
        </button>
        <button class="ob-card" disabled={busy} onClick={async () => { setBusy(true); setErr(''); try { await invoke('setup_local'); done() } catch (x) { setErr(String(x)) } finally { setBusy(false) } }}>
          <strong>{busy ? 'Setting up…' : 'Just this computer'}</strong><span>No server: your AI usage, agent status, system monitor and storage on this computer only. Nothing leaves it. You can connect to a server later.</span>
        </button>
      </div>
      {err && <p class="err" role="alert">{err}</p>}
      <div class="group" style={{ marginTop: 16 }}><DockToggle /></div>
    </div>
  )
}
