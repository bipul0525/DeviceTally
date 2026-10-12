import { Hono } from 'hono'
import { login, logout, logoutEverywhere, requireDevice, requireOwner, setup, type Env } from './auth'
import { enrollCode, randomToken, sha256 } from './crypto'
import { dayOf, ownerTimezone } from './days'
import { dashboard, overview, sessionDetail, sessions, summarize } from './dashboard'
import { diskTrends, reportHealth } from './health'
import { ingest } from './ingest'
import { appScript, download, installScript, latestTag, releaseAvailable, tokscaleDownload } from './install'
import { TOOLS, toolsIngest } from './tools'
import { nightly } from './nightly'
import { AGENT_MIN_SUPPORTED, SERVER_VERSION } from './version'

const ENROLL_TTL_MS = 15 * 60_000
// Wrong enrollment codes allowed per client address per window before it is blocked.
const ENROLL_FAILS = 10
const ENROLL_WINDOW_MS = 15 * 60_000

const older = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number))
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0)
  return false
}

const app = new Hono<Env>()
// Errors the app can explain: Cloudflare's free D1 plan stops the database for the rest of the day
// (UTC) once its daily reads or writes are used up.
app.onError((err, c) => {
  const msg = String(err?.message ?? err)
  if (/exceeded D1's free tier|daily row (read|write) limit/i.test(msg)) return c.json({ error: 'db_limit' }, 503)
  console.error(err)
  return c.json({ error: 'server_error' }, 500)
})

// --- Owner login ---
app.post('/api/auth/setup', setup)
app.post('/api/auth/login', login)
app.post('/api/auth/logout', logout)
app.get('/app', (c) => appScript(c.req.url))
app.get('/dl/tokscale/:version/:pkg', (c) => tokscaleDownload(c.req.param('version'), c.req.param('pkg').replace(/\.tgz$/, ''), c.executionCtx))
app.get('/dl/:name', (c) => download(c.req.param('name'), c.env.RELEASE_REPO, c.executionCtx))
app.get('/i/:code', (c) => installScript(c.req.url, c.req.header('user-agent') ?? '', c.env.RELEASE_REPO))
app.get('/api/meta', async (c) => c.json({ version: SERVER_VERSION, host: c.env.HOST || 'cloudflare', release_repo: c.env.RELEASE_REPO || null, release_available: await releaseAvailable(c.env.RELEASE_REPO) }))
app.get('/', (c) => c.text(`DeviceTally server. Install the app:  curl -fsSL ${new URL(c.req.url).origin}/app | sh\n`))
// Lets the app choose between creating the admin login and signing in.
app.get('/api/auth/state', async (c) => c.json({ setup_needed: !(await c.env.DB.prepare('SELECT 1 FROM owner WHERE id = 1').first()) }))

// --- Agent API (v1) ---
// Registered before the dashboard routes so the owner check on /api/* never runs for them.
app.post('/api/v1/enroll', async (c) => {
  const { code, os, arch, agent_version, account, previous } = await c.req.json<Record<string, string> & { account?: Record<string, string>; previous?: { device_id?: string; device_key?: string } }>()
  const now = Date.now()
  const rlKey = `enroll:${c.req.header('cf-connecting-ip') ?? 'unknown'}`
  const rl = await c.env.DB.prepare('SELECT window_start, count FROM rate_limits WHERE key = ?').bind(rlKey).first<{ window_start: number; count: number }>()
  if (rl && now - rl.window_start < ENROLL_WINDOW_MS && rl.count >= ENROLL_FAILS) {
    return c.json({ error: 'too_many_attempts', retry_at: rl.window_start + ENROLL_WINDOW_MS }, 429)
  }
  // Single use: the UPDATE only succeeds once, and only before expiry.
  const row = await c.env.DB.prepare('UPDATE enroll_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING device_name')
    .bind(now, await sha256(String(code ?? '').toUpperCase()), now).first<{ device_name: string }>()
  if (!row) {
    await c.env.DB.prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT (key) DO UPDATE SET count = CASE WHEN ?2 - window_start < ?3 THEN count + 1 ELSE 1 END,
         window_start = CASE WHEN ?2 - window_start < ?3 THEN window_start ELSE ?2 END`,
    ).bind(rlKey, now, ENROLL_WINDOW_MS).run()
    return c.json({ error: 'bad_or_expired_code' }, 403)
  }
  const key = randomToken()
  // Joining again on the same computer (it proves it with its previous key, even if that device was
  // disconnected): the same device keeps its history and sessions, with a new key. Otherwise a new one.
  const same = previous?.device_id && previous.device_key
    ? await c.env.DB.prepare('SELECT id FROM devices WHERE id = ? AND key_hash = ?').bind(previous.device_id, await sha256(previous.device_key)).first<{ id: string }>()
    : null
  const id = same?.id ?? crypto.randomUUID()
  if (same) {
    await c.env.DB.prepare('UPDATE devices SET name = ?, os = ?, arch = ?, agent_version = ?, key_hash = ?, last_seen = ?, revoked_at = NULL, disconnect_requested_at = NULL WHERE id = ?')
      .bind(row.device_name, os ?? null, arch ?? null, agent_version ?? null, await sha256(key), now, id).run()
  } else {
    await c.env.DB.prepare('INSERT INTO devices (id, name, os, arch, agent_version, key_hash, created_at, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(id, row.device_name, os ?? null, arch ?? null, agent_version ?? null, await sha256(key), now, now).run()
  }
  // The account confirmed at install ("Track you@work.com? [Y/n]") is approved: the owner's code authorises it.
  if (account?.uuid) {
    await c.env.DB.prepare(
      `INSERT INTO accounts (uuid, email, display_name, org_name, plan, status, first_seen_device, first_seen_at) VALUES (?, ?, ?, ?, ?, 'approved', ?, ?)
       ON CONFLICT (uuid) DO UPDATE SET status = 'approved' WHERE accounts.status = 'pending'`, // an "ignored" choice stays
    ).bind(account.uuid, account.email ?? null, account.display_name ?? null, account.org_name ?? null, account.plan ?? null, id, now).run()
  }
  return c.json({ device_id: id, device_key: key, device_name: row.device_name })
})

const agent = new Hono<Env>()
agent.use(requireDevice)
agent.use(async (c, next) => {
  const v = c.req.header('x-devicetally-agent')
  if (v && older(v, AGENT_MIN_SUPPORTED)) return c.json({ error: 'update_required', min_supported: AGENT_MIN_SUPPORTED }, 426)
  await next()
})
agent.get('/config', async (c) => {
  const db = c.env.DB
  await db.prepare('UPDATE devices SET last_seen = ?, agent_version = coalesce(?, agent_version) WHERE id = ?')
    .bind(Date.now(), c.req.header('x-devicetally-agent') ?? null, c.get('deviceId')).run()
  const [accounts, settings] = await db.batch([
    db.prepare('SELECT uuid, status FROM accounts'),
    db.prepare('SELECT scope, scope_id, json FROM settings'),
  ])
  return c.json({
    device_id: c.get('deviceId'),
    accounts: accounts.results,
    settings: (settings.results as { scope: string; scope_id: string; json: string }[]).map((s) => ({ ...s, json: JSON.parse(s.json) })),
    server_version: SERVER_VERSION,
    release_repo: c.env.RELEASE_REPO || null,
    // Agents update from this server's /dl/ (edge-cached), not from GitHub directly.
    agent_latest: c.env.RELEASE_REPO ? (await latestTag(c.env.RELEASE_REPO))?.replace(/^v/, '') ?? null : null,
    agent_min_supported: AGENT_MIN_SUPPORTED,
  })
})
// A joined computer can't disconnect itself (that would defeat tracking); it asks, and the admin decides.
agent.get('/disconnect-request', async (c) =>
  c.json({ requested_at: (await c.env.DB.prepare('SELECT disconnect_requested_at AS t FROM devices WHERE id = ?').bind(c.get('deviceId')).first<{ t: number | null }>())?.t ?? null }))
agent.post('/disconnect-request', async (c) => {
  await c.env.DB.prepare('UPDATE devices SET disconnect_requested_at = coalesce(disconnect_requested_at, ?) WHERE id = ?').bind(Date.now(), c.get('deviceId')).run()
  return c.json({ ok: true })
})
agent.delete('/disconnect-request', async (c) => {
  await c.env.DB.prepare('UPDATE devices SET disconnect_requested_at = NULL WHERE id = ?').bind(c.get('deviceId')).run()
  return c.json({ ok: true })
})
agent.post('/health', reportHealth)
agent.post('/ingest', ingest)
agent.post('/tools', toolsIngest)
// The tray app on a connected machine: that device's own usage only, with its device key (no admin login).
// The app's main window on a connected machine: that device only, and no prompt text anywhere.
agent.get('/overview', (c) => overview(c as never))
agent.get('/sessions', (c) => sessions(c as never))
agent.get('/sessions/:id', (c) => sessionDetail(c as never))
agent.get('/summary', async (c) => c.json(await summarize(c.env.DB, c.req.query('range'), c.get('deviceId'))))
app.route('/api/v1', agent)

// --- Dashboard API (owner session) ---
const owner = new Hono<Env>()
owner.use(requireOwner)
owner.get('/auth/me', async (c) => c.json(await c.env.DB.prepare('SELECT email, timezone FROM owner WHERE id = 1').first()))
owner.post('/auth/logout-everywhere', logoutEverywhere)

owner.put('/owner/timezone', async (c) => {
  const { timezone } = await c.req.json<{ timezone: string }>()
  try { dayOf(0, timezone) } catch { return c.json({ error: 'bad_timezone' }, 400) }
  // Applies to new data only: re-cutting every stored day would cost one write per row.
  await c.env.DB.prepare('UPDATE owner SET timezone = ? WHERE id = 1').bind(timezone).run()
  return c.json({ ok: true })
})

owner.post('/devices/enroll', async (c) => {
  const { name } = await c.req.json<{ name: string }>()
  if (!name?.trim()) return c.json({ error: 'name_required' }, 400)
  const code = enrollCode()
  const expires_at = Date.now() + ENROLL_TTL_MS
  await c.env.DB.prepare('INSERT INTO enroll_codes (code_hash, device_name, expires_at) VALUES (?, ?, ?)').bind(await sha256(code), name.trim(), expires_at).run()
  return c.json({ code, expires_at })
})
owner.get('/devices', async (c) => {
  const rows = (await c.env.DB.prepare('SELECT id, name, os, arch, agent_version, created_at, last_seen, revoked_at, disconnect_requested_at, health, health_at FROM devices ORDER BY created_at').all()).results as Record<string, unknown>[]
  const trends = await diskTrends(c.env.DB)
  return c.json(rows.map((r) => ({ ...r, health: r.health ? JSON.parse(r.health as string) : null, disk_full_in_days: trends.get(r.id as string) ?? null })))
})
owner.patch('/devices/:id', async (c) => {
  const { name, revoked, decline_disconnect } = await c.req.json<{ name?: string; revoked?: boolean; decline_disconnect?: boolean }>()
  const id = c.req.param('id')
  if (name?.trim()) await c.env.DB.prepare('UPDATE devices SET name = ? WHERE id = ?').bind(name.trim(), id).run()
  if (revoked) await c.env.DB.prepare('UPDATE devices SET revoked_at = coalesce(revoked_at, ?) WHERE id = ?').bind(Date.now(), id).run()
  if (decline_disconnect) await c.env.DB.prepare('UPDATE devices SET disconnect_requested_at = NULL WHERE id = ?').bind(id).run()
  return c.json({ ok: true })
})

owner.get('/accounts', async (c) =>
  c.json((await c.env.DB.prepare('SELECT uuid, email, display_name, org_name, plan, status, first_seen_device, first_seen_at FROM accounts').all()).results))
owner.patch('/accounts/:uuid', async (c) => {
  const { status } = await c.req.json<{ status: string }>()
  if (!['approved', 'ignored', 'pending'].includes(status)) return c.json({ error: 'bad_status' }, 400)
  const r = await c.env.DB.prepare('UPDATE accounts SET status = ? WHERE uuid = ?').bind(status, c.req.param('uuid')).run()
  return r.meta.changes ? c.json({ ok: true }) : c.json({ error: 'not_found' }, 404)
})

owner.get('/settings', async (c) => c.json((await c.env.DB.prepare('SELECT scope, scope_id, json FROM settings').all()).results))
owner.put('/settings/:scope/:scopeId?', async (c) => {
  const scope = c.req.param('scope')
  if (!['global', 'account', 'device', 'project'].includes(scope)) return c.json({ error: 'bad_scope' }, 400)
  const body = await c.req.json()
  await c.env.DB.prepare('INSERT INTO settings (scope, scope_id, json) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET json = excluded.json')
    .bind(scope, c.req.param('scopeId') ?? '', JSON.stringify(body)).run()
  return c.json({ ok: true })
})
owner.route('/', dashboard)
app.route('/api', owner)

export default {
  fetch: app.fetch,
  scheduled: (_e: ScheduledController, env: Env['Bindings'], ctx: ExecutionContext) => ctx.waitUntil(nightly(env.DB)),
} satisfies ExportedHandler<Env['Bindings']>
