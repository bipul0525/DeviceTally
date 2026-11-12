import { SELF, env } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nightly } from '../src/nightly'
import type { Batch, TurnIn } from '../src/ingest'

const BASE = 'https://dt.example'
const EMAIL = 'owner@example.com'
const PASSWORD = 'correct horse battery staple'

const call = (path: string, init: RequestInit & { json?: unknown; cookie?: string; key?: string; agent?: string } = {}) => {
  const headers = new Headers(init.headers)
  if (init.json !== undefined) headers.set('content-type', 'application/json')
  if (init.cookie) headers.set('cookie', init.cookie)
  if (init.key) headers.set('authorization', `Bearer ${init.key}`)
  if (init.agent) headers.set('x-devicetally-agent', init.agent)
  return SELF.fetch(BASE + path, { method: init.json !== undefined ? 'POST' : 'GET', ...init, headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body })
}

/** Owner set up (timezone Asia/Kolkata, UTC+5:30) and logged in; returns the session cookie. */
async function owner() {
  let r = await call('/api/auth/setup', { json: { token: 'test-setup-token', email: EMAIL, password: PASSWORD, timezone: 'Asia/Kolkata' } })
  if (r.status === 409) r = await call('/api/auth/login', { json: { email: EMAIL, password: PASSWORD } })
  expect(r.status).toBe(200)
  return r.headers.get('set-cookie')!.split(';')[0]
}

async function device(cookie: string, name = 'Office PC') {
  const { code } = await (await call('/api/devices/enroll', { json: { name }, cookie })).json<{ code: string }>()
  const r = await call('/api/v1/enroll', { json: { code, os: 'darwin', arch: 'arm64', agent_version: '0.1.0' } })
  expect(r.status).toBe(200)
  return (await r.json<{ device_id: string; device_key: string }>()).device_key
}

let n = 0
async function approvedAccount(cookie: string, key: string) {
  const uuid = `acct-${++n}`
  await call('/api/v1/ingest', { json: { accounts: [{ uuid, email: `${uuid}@example.com` }] }, key })
  expect((await call(`/api/accounts/${uuid}`, { method: 'PATCH', json: { status: 'approved' }, cookie })).status).toBe(200)
  return uuid
}

const T0 = Date.parse('2026-10-03T06:00:00Z')
const session = (id: string, account_uuid: string, started_at = T0) => ({ id, account_uuid, project_key: 'github.com/me/repo', started_at, ended_at: started_at })
const turn = (id: string, session_id: string, account_uuid: string, out_tok: number, ts = T0, extra: Partial<TurnIn> = {}): TurnIn => ({
  id, session_id, account_uuid, ts, model: 'claude-opus-5-5', effort: 'high', in_tok: 10, out_tok, cache_write_tok: 0, cache_read_tok: 100, thinking_tok: null, ...extra,
})
const ingest = async (key: string, b: Batch) => {
  const r = await call('/api/v1/ingest', { json: b, key })
  expect(r.status).toBe(200)
  return r.json<{ accepted: Record<string, number>; dropped: Record<string, number> }>()
}
const totals = (account: string) =>
  env.DB.prepare(`SELECT sum(in_tok) in_tok, sum(out_tok) out_tok, sum(thinking_tok) thinking_tok, sum(turns) turns, sum(prompts) prompts,
                         sum(sessions) sessions, sum(active_seconds) active_seconds FROM daily_rollup WHERE account_uuid = ?`).bind(account).first<Record<string, number>>()

describe('owner login', () => {
  it('needs the setup token, and setup only works once', async () => {
    expect((await call('/api/auth/setup', { json: { token: 'wrong', email: 'x@y.z', password: 'long enough pw' } })).status).toBe(403)
    await owner()
    expect((await call('/api/auth/setup', { json: { token: 'test-setup-token', email: 'evil@x.com', password: 'long enough pw' } })).status).toBe(409)
  })

  it('sets a 30-day HttpOnly session cookie and protects dashboard routes', async () => {
    await owner()
    const r = await call('/api/auth/login', { json: { email: EMAIL, password: PASSWORD } })
    const set = r.headers.get('set-cookie')!
    expect(set).toMatch(/HttpOnly/)
    expect(set).toMatch(/SameSite=Strict/)
    expect(set).toMatch(/Max-Age=2592000/)
    expect((await call('/api/devices')).status).toBe(401)
    expect((await call('/api/devices', { cookie: set.split(';')[0] })).status).toBe(200)
  })

  it('locks out after 5 wrong passwords', async () => {
    await owner()
    for (let i = 0; i < 5; i++) expect((await call('/api/auth/login', { json: { email: EMAIL, password: 'nope' } })).status).toBe(401)
    expect((await call('/api/auth/login', { json: { email: EMAIL, password: PASSWORD } })).status).toBe(429)
    await env.DB.prepare('UPDATE owner SET failed_logins = 0, locked_until = NULL').run() // storage is shared between tests
  })
})

describe('devices', () => {
  it('enroll codes are single use', async () => {
    const cookie = await owner()
    const { code } = await (await call('/api/devices/enroll', { json: { name: 'Home Mac' }, cookie })).json<{ code: string }>()
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{6}$/)
    expect((await call('/api/v1/enroll', { json: { code } })).status).toBe(200)
    expect((await call('/api/v1/enroll', { json: { code } })).status).toBe(403)
  })

  it('approves the account confirmed at enroll', async () => {
    const cookie = await owner()
    const { code } = await (await call('/api/devices/enroll', { json: { name: 'Laptop' }, cookie })).json<{ code: string }>()
    await call('/api/v1/enroll', { json: { code, account: { uuid: 'acct-enroll', email: 'me@work.com' } } })
    const accounts = await (await call('/api/accounts', { cookie })).json<{ uuid: string; status: string }[]>()
    expect(accounts.find((a) => a.uuid === 'acct-enroll')?.status).toBe('approved')
  })

  it('blocks an address after 10 wrong codes', async () => {
    const ip = { 'cf-connecting-ip': '203.0.113.7' }
    for (let i = 0; i < 10; i++) expect((await call('/api/v1/enroll', { json: { code: 'ZZZZZZ' }, headers: ip })).status).toBe(403)
    expect((await call('/api/v1/enroll', { json: { code: 'ZZZZZZ' }, headers: ip })).status).toBe(429)
    // Other addresses are unaffected.
    expect((await call('/api/v1/enroll', { json: { code: 'ZZZZZZ' }, headers: { 'cf-connecting-ip': '203.0.113.8' } })).status).toBe(403)
  })

  it('revoked keys stop working at once', async () => {
    const cookie = await owner()
    const key = await device(cookie)
    const cfg = await (await call('/api/v1/config', { key })).json<{ device_id: string }>()
    await call(`/api/devices/${cfg.device_id}`, { method: 'PATCH', json: { revoked: true }, cookie })
    expect((await call('/api/v1/config', { key })).status).toBe(401)
  })

  it('a computer can only ask to be disconnected; the admin decides', async () => {
    const cookie = await owner()
    const key = await device(cookie, 'Request PC')
    const { device_id } = await (await call('/api/v1/config', { key })).json<{ device_id: string }>()
    expect((await call('/api/v1/disconnect-request', { json: {}, key })).status).toBe(200)
    expect((await (await call('/api/v1/disconnect-request', { key })).json<{ requested_at: number | null }>()).requested_at).toBeGreaterThan(0)
    const listed = async () => (await (await call('/api/devices', { cookie })).json<{ id: string; disconnect_requested_at: number | null }[]>()).find((d) => d.id === device_id)!
    expect((await listed()).disconnect_requested_at).toBeGreaterThan(0)
    // Still tracked until the admin approves.
    expect((await call('/api/v1/config', { key })).status).toBe(200)
    await call(`/api/devices/${device_id}`, { method: 'PATCH', json: { decline_disconnect: true }, cookie })
    expect((await listed()).disconnect_requested_at).toBeNull()
    // Asking again can be withdrawn by the computer itself.
    await call('/api/v1/disconnect-request', { json: {}, key })
    await call('/api/v1/disconnect-request', { method: 'DELETE', key })
    expect((await listed()).disconnect_requested_at).toBeNull()
  })

  it('stores each computer\'s health and a daily disk reading', async () => {
    const cookie = await owner()
    const key = await device(cookie, 'Health PC')
    const { device_id } = await (await call('/api/v1/config', { key })).json<{ device_id: string }>()
    const report = { hooks: 'locked', paused: false, removed: [{ path: '/x.jsonl', at: 1 }], disk_free: 50e9, disk_total: 250e9, app: '0.10.0' }
    expect((await call('/api/v1/health', { json: report, key })).status).toBe(200)
    const d = (await (await call('/api/devices', { cookie })).json<{ id: string; health: typeof report | null; health_at: number }[]>()).find((x) => x.id === device_id)!
    expect(d.health).toMatchObject({ hooks: 'locked', removed: [{ path: '/x.jsonl' }] })
    expect(d.health_at).toBeGreaterThan(0)
    expect((await call('/api/v1/health', { json: { pad: 'x'.repeat(20_000) }, key })).status).toBe(413)
    expect((await call('/api/v1/health', { json: report })).status).toBe(401)
  })

  it('tells too-old agents to update', async () => {
    const key = await device(await owner())
    expect((await call('/api/v1/config', { key, agent: '0.0.9' })).status).toBe(426)
    expect((await call('/api/v1/config', { key, agent: '0.1.0' })).status).toBe(200)
  })
})

describe('ingest', () => {
  it('drops data from accounts that are not approved', async () => {
    const cookie = await owner()
    const key = await device(cookie)
    await ingest(key, { accounts: [{ uuid: 'stranger', email: 'colleague@example.com' }] })
    const r = await ingest(key, { sessions: [session('s-x', 'stranger')], turns: [turn('m-x', 's-x', 'stranger', 50)] })
    expect(r.accepted).toEqual({ sessions: 0, turns: 0, prompts: 0 })
    expect(r.dropped.unapproved).toBe(2)
    const accounts = await (await call('/api/accounts', { cookie })).json<{ uuid: string; status: string }[]>()
    expect(accounts.find((a) => a.uuid === 'stranger')?.status).toBe('pending')
  })

  it('counts a reply once, using its most complete line (Phase 0 duplicate lines)', async () => {
    const cookie = await owner()
    const key = await device(cookie)
    const a = await approvedAccount(cookie, key)
    await ingest(key, { sessions: [session('s1', a)], turns: [turn('m1', 's1', a, 8)] })
    await ingest(key, { sessions: [session('s1', a)], turns: [turn('m1', 's1', a, 106, T0, { thinking_tok: 20 })] })
    expect(await totals(a)).toMatchObject({ in_tok: 10, out_tok: 106, thinking_tok: 20, turns: 1, sessions: 1 })
    // An older, partial line arriving late must not lower the count.
    await ingest(key, { turns: [turn('m1', 's1', a, 8)] })
    expect((await totals(a))!.out_tok).toBe(106)
  })

  it('re-sending a batch changes nothing and writes no turn rows', async () => {
    const cookie = await owner()
    const key = await device(cookie)
    const a = await approvedAccount(cookie, key)
    const b: Batch = {
      sessions: [session('s2', a)],
      prompts: [{ id: 'p1', session_id: 's2', account_uuid: a, ts: T0, text: 'refactor sync' }],
      turns: [turn('m2', 's2', a, 40), turn('m3', 's2', a, 60, T0 + 60_000)],
    }
    expect((await ingest(key, b)).accepted).toEqual({ sessions: 1, turns: 2, prompts: 1 })
    const before = await totals(a)
    expect((await ingest(key, b)).accepted).toEqual({ sessions: 1, turns: 0, prompts: 0 })
    expect(await totals(a)).toEqual(before)
    expect(before).toMatchObject({ out_tok: 100, turns: 2, prompts: 1, sessions: 1 })
  })

  it('computes active time across split batches, ignoring idle gaps', async () => {
    const cookie = await owner()
    const key = await device(cookie)
    const a = await approvedAccount(cookie, key)
    const s = session('s3', a)
    // Events at 0s, 60s | 120s, then idle 30 min, then 1830s. Active = 60 + 60 + 0 (idle) = 120s.
    await ingest(key, { sessions: [s], prompts: [{ id: 'p3', session_id: 's3', account_uuid: a, ts: T0 }], turns: [turn('m4', 's3', a, 1, T0 + 60_000)] })
    await ingest(key, { sessions: [s], turns: [turn('m5', 's3', a, 1, T0 + 120_000), turn('m6', 's3', a, 1, T0 + 1_920_000)] })
    expect((await totals(a))!.active_seconds).toBe(120)
    expect(await env.DB.prepare('SELECT active_seconds FROM sessions WHERE id = ?').bind('s3').first('active_seconds')).toBe(120)
  })

  it("cuts days in the owner's time zone, not UTC", async () => {
    const cookie = await owner()
    const key = await device(cookie)
    const a = await approvedAccount(cookie, key)
    const late = Date.parse('2026-10-02T20:00:00Z') // 01:30 on Oct 3 in Kolkata
    await ingest(key, { sessions: [session('s4', a, late)], turns: [turn('m7', 's4', a, 5, late)] })
    const days = (await env.DB.prepare('SELECT DISTINCT day FROM daily_rollup WHERE account_uuid = ?').bind(a).all<{ day: string }>()).results
    expect(days.map((d) => d.day)).toEqual(['2026-10-03'])
  })

  it("rejects another device's session id", async () => {
    const cookie = await owner()
    const k1 = await device(cookie, 'A')
    const k2 = await device(cookie, 'B')
    const a = await approvedAccount(cookie, k1)
    await ingest(k1, { sessions: [session('s5', a)] })
    const r = await ingest(k2, { sessions: [session('s5', a)], turns: [turn('m8', 's5', a, 5)] })
    expect(r.accepted.turns).toBe(0)
    expect(r.dropped.unknown_session).toBe(1)
  })

  it('refuses oversized batches', async () => {
    const key = await device(await owner())
    const turns = Array.from({ length: 501 }, (_, i) => turn(`x${i}`, 's', 'a', 1))
    expect((await call('/api/v1/ingest', { json: { turns }, key })).status).toBe(413)
  })
})

describe('nightly', () => {
  it('rebuilt rollups equal the incremental ones', async () => {
    const cookie = await owner()
    const key = await device(cookie)
    const a = await approvedAccount(cookie, key)
    await ingest(key, {
      sessions: [session('s6', a)],
      prompts: [{ id: 'p6', session_id: 's6', account_uuid: a, ts: T0 }],
      turns: [turn('m9', 's6', a, 30, T0 + 30_000, { thinking_tok: 5 }), turn('m10', 's6', a, 70, T0 + 90_000)],
    })
    await ingest(key, { turns: [turn('m9', 's6', a, 45, T0 + 30_000, { thinking_tok: 9 })] })
    const incremental = await totals(a)
    await nightly(env.DB, T0 + 3600_000)
    expect(await totals(a)).toEqual(incremental)
    expect(incremental).toMatchObject({ out_tok: 115, thinking_tok: 9, turns: 2, prompts: 1, sessions: 1, active_seconds: 90 })
  })

  it('deletes prompts past the retention period', async () => {
    const cookie = await owner()
    const key = await device(cookie)
    const a = await approvedAccount(cookie, key)
    await ingest(key, { sessions: [session('s7', a)], prompts: [{ id: 'p7', session_id: 's7', account_uuid: a, ts: T0, text: 'old' }] })
    await nightly(env.DB, T0 + 91 * 24 * 3600_000)
    expect(await env.DB.prepare('SELECT count(*) n FROM prompts WHERE id = ?').bind('p7').first('n')).toBe(0)
  })
})

describe('dashboard API', () => {
  // The seeded usage is from T0; "this month" and "last 30 days" are read on that day, not today.
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: T0 + 6 * 3600_000 }) })
  afterEach(() => { vi.useRealTimers() })
  async function seeded() {
    const cookie = await owner()
    const key = await device(cookie, 'Dash PC')
    const a = await approvedAccount(cookie, key)
    const sid = `dash-${a}`
    await ingest(key, {
      sessions: [{ ...session(sid, a), title: 'Fix login' }],
      prompts: [
        { id: `${sid}-p1`, session_id: sid, account_uuid: a, ts: T0, text: 'please refactor the authentication middleware' },
        { id: `${sid}-p2`, session_id: sid, account_uuid: a, ts: T0 + 60_000, text: 'now write tests' },
      ],
      turns: [
        turn(`${sid}-m1`, sid, a, 1_000_000, T0 + 30_000, { in_tok: 0, cache_read_tok: 0 }),
        turn(`${sid}-m2`, sid, a, 0, T0 + 90_000, { model: 'unknown-model', in_tok: 5, cache_read_tok: 0 }),
      ],
    })
    return { cookie, key, a, sid }
  }

  it('overview totals, API-equivalent cost, breakdowns and the day-by-hour grid', async () => {
    const { cookie, a } = await seeded()
    const r = await (await call(`/api/overview?from=2026-10-01&to=2026-10-03&account=${a}`, { cookie })).json<any>()
    expect(r.totals).toMatchObject({ out_tok: 1_000_000, in_tok: 5, turns: 2, prompts: 2, sessions: 1 })
    expect(r.totals.cost).toBeCloseTo(20, 6) // 1M output tokens of claude-opus-5-5 at $20 / M
    expect(r.unpriced).toEqual(['unknown-model'])
    expect(r.by.model.map((m: any) => m.key).sort()).toEqual(['claude-opus-5-5', 'unknown-model'])
    expect(r.daily).toHaveLength(3)
    // 06:00Z is 11:30 in Kolkata, on a Saturday (row 5 when Monday = 0).
    expect(r.heat[5][11]).toBe(4)
  })

  it('prices 1-hour cache writes higher than 5-minute ones', async () => {
    const cookie = await owner()
    const key = await device(cookie)
    const a = await approvedAccount(cookie, key)
    // claude-opus-5-5: cache write $5 / M (5 min), $8 / M (1 hour).
    await ingest(key, { sessions: [session('s-1h', a)], turns: [turn('m-1h', 's-1h', a, 0, T0, { in_tok: 0, cache_read_tok: 0, cache_write_tok: 3_000_000, cache_write_1h_tok: 1_000_000 })] })
    const r = await (await call(`/api/overview?from=2026-10-01&to=2026-10-03&account=${a}`, { cookie })).json<any>()
    expect(r.totals.cost).toBeCloseTo(2 * 5 + 1 * 8, 6)
  })

  it('lists sessions and opens one as a timeline', async () => {
    const { cookie, a, sid } = await seeded()
    const list = await (await call(`/api/sessions?from=2026-10-01&to=2026-10-03&account=${a}`, { cookie })).json<any[]>()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: sid, title: 'Fix login', prompts: 2, tokens: 1_000_005 })
    const d = await (await call(`/api/sessions/${sid}`, { cookie })).json<any>()
    // The timeline says when prompts were sent, never what they said.
    expect(d.prompts).toHaveLength(2)
    expect(d.prompts.every((p: any) => !('text' in p))).toBe(true)
    const texts = await (await call(`/api/sessions/${sid}/prompts`, { cookie })).json<any[]>()
    expect(texts.map((p) => p.text)).toEqual(['please refactor the authentication middleware', 'now write tests'])
    expect(d.turns[0].cost).toBeCloseTo(20, 6)
  })

  it('searches prompts with full-text search, prefix matching the last word', async () => {
    const { cookie, a } = await seeded()
    const hits = await (await call(`/api/prompts?from=2026-10-01&to=2026-10-03&account=${a}&q=${encodeURIComponent('authentic')}`, { cookie })).json<any[]>()
    expect(hits).toHaveLength(1)
    expect(hits[0].text).toContain('\u0002authentication\u0003')
    const none = await (await call(`/api/prompts?from=2026-10-01&to=2026-10-03&account=${a}&q=${encodeURIComponent('"); DROP TABLE prompts; --')}`, { cookie })).json<any[]>()
    expect(none).toEqual([])
  })

  it('deletes a device and rebuilds totals', async () => {
    const { cookie, a } = await seeded()
    const devices = await (await call('/api/devices', { cookie })).json<{ id: string; name: string }[]>()
    const dev = devices.filter((d) => d.name === 'Dash PC').at(-1)!
    expect((await call('/api/data/delete', { json: { scope: 'device', id: dev.id }, cookie })).status).toBe(200)
    expect(await totals(a)).toMatchObject({ turns: null, prompts: null })
  })

  it('exports CSV with a cost column', async () => {
    const { cookie } = await seeded()
    const r = await call('/api/export?format=csv', { cookie })
    expect(r.headers.get('content-type')).toContain('text/csv')
    const text = await r.text()
    expect(text.split('\n')[0]).toContain('cost_estimate_usd')
  })

  it('a connected machine sees only its own overview and sessions, and never prompt text', async () => {
    const { cookie, key, sid } = await seeded()
    const otherKey = await device(cookie, 'Neighbour PC')
    const ov = await (await call('/api/v1/overview?from=2026-10-01&to=2026-10-03', { key })).json<any>()
    expect(ov.labels.devices).toEqual([expect.objectContaining({ name: 'Dash PC' })])
    expect(JSON.stringify(ov)).not.toContain('Neighbour PC')
    // Asking for another device is ignored: the device filter is forced.
    const theirs = await (await call('/api/v1/overview?from=2026-10-01&to=2026-10-03', { key: otherKey })).json<any>()
    expect(theirs.totals.tokens).toBe(0)
    const list = await (await call('/api/v1/sessions?from=2026-10-01&to=2026-10-03', { key })).json<any[]>()
    expect(list.map((x) => x.id)).toContain(sid)
    const detail = await (await call(`/api/v1/sessions/${sid}`, { key })).json<any>()
    expect(JSON.stringify(detail)).not.toContain('refactor')
    expect((await call(`/api/v1/sessions/${sid}`, { key: otherKey })).status).toBe(404)
    expect([401, 404]).toContain((await call(`/api/v1/sessions/${sid}/prompts`, { key })).status) // denied either way
  })

  it("a device's own summary never includes other devices", async () => {
    const { cookie, key, a, sid } = await seeded()
    const other = await device(cookie, 'Someone else')
    await call('/api/v1/tools', { json: { seen: ['codex'] }, key: other })
    const mine = await (await call('/api/v1/summary?range=30d', { key })).json<any>()
    expect(mine.scope).toBe('device')
    expect(mine.device.name).toBe('Dash PC')
    expect(mine.by_device).toEqual([])
    expect(mine.by_model.length).toBeGreaterThan(0)
    expect(JSON.stringify(mine)).not.toContain('Someone else')
    expect((await call('/api/v1/summary')).status).toBe(401)
    void a; void sid
  })

  it('summarises today for the tray app, by tool and device', async () => {
    const cookie = await owner()
    const r = await (await call('/api/summary?range=7d', { cookie })).json<any>()
    expect(r.range.days).toBe(7)
    expect(r).toHaveProperty('tokens')
    expect(r).toHaveProperty('previous_tokens')
    expect(Array.isArray(r.by_tool) && Array.isArray(r.by_device)).toBe(true)
    expect(r.by_device.every((d: any) => typeof d.chip === 'number' && !('prompts' in d))).toBe(true)
  })

  it('shows each device with its usage, last activity and last prompt', async () => {
    const { cookie } = await seeded()
    const rows = await (await call('/api/device-usage', { cookie })).json<any[]>()
    const dash = rows.filter((d) => d.name === 'Dash PC').at(-1)
    expect(dash.month).toBeGreaterThan(0)
    expect(typeof dash.last_active).toBe('number')
    expect(typeof dash.last_prompt).toBe('number')
    expect(typeof dash.chip).toBe('number')
  })

  it('lists people with their usage and computers', async () => {
    const { cookie, a } = await seeded()
    const people = await (await call('/api/people', { cookie })).json<any[]>()
    const me = people.find((p) => p.uuid === a)
    expect(me).toMatchObject({ status: 'approved' })
    expect(me.month).toBeGreaterThan(0)
    expect(me.devices.map((d: any) => d.name)).toContain('Dash PC')
    expect(typeof me.last_active).toBe('number')
  })

  it('is not reachable without the owner session', async () => {
    for (const p of ['/api/device-usage', '/api/people', '/api/summary', '/api/overview', '/api/sessions', '/api/prompts', '/api/export', '/api/usage']) expect((await call(p)).status).toBe(401)
  })
})

describe('installer', () => {
  it('serves a checksum-verifying shell script, or PowerShell to PowerShell', async () => {
    const sh = await (await call('/i/K7XR4M')).text()
    expect(sh).toContain('#!/bin/sh')
    expect(sh).toContain('SERVER="https://dt.example"; CODE="K7XR4M"')
    expect(sh).toContain('Checksum mismatch')
    expect(sh).toContain('base="$SERVER/dl"')
    const ps = await (await call('/i/k7xr4m', { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT; Windows NT 10.0) WindowsPowerShell/5.1' } })).text()
    expect(ps).toContain("$code = 'K7XR4M'")
    expect(ps).toContain('Get-FileHash')
  })

  it('serves the app installer, which installs without the quarantine mark', async () => {
    const sh = await (await call('/app')).text()
    expect(sh).toContain('SERVER="https://dt.example"')
    expect(sh).toContain('/dl/$asset')
    expect(sh).not.toContain('xattr') // curl downloads carry no quarantine mark, nothing to remove
  })

  it('rejects anything that is not an enrollment code', async () => {
    for (const p of ['/i/K7XR4', "/i/K7XR4M';rm", '/i/OOOOOO']) expect((await call(p)).status).toBe(404)
  })

  it('tells agents which repo to update from', async () => {
    const key = await device(await owner())
    expect((await (await call('/api/v1/config', { key })).json<{ release_repo: string }>()).release_repo).toBe('me/devicetally')
  })
})

describe('other AI tools', () => {
  const day = '2026-10-02'
  const codexRow = (out: number) => ({ tool: 'codex', model: 'gpt-6.1-sol', provider: 'openai', in_tok: 1_000_000, out_tok: out, cache_read_tok: 0, cache_write_tok: 0, reasoning_tok: 0, messages: 3 })
  const upload = (key: string, body: object) => call('/api/v1/tools', { json: body, key })
  const enable = (cookie: string, tools: Record<string, boolean>) => call('/api/settings/global', { method: 'PUT', json: { tools }, cookie })

  it('records tools found on a device, but stores nothing until a tool is enabled', async () => {
    const cookie = await owner()
    const key = await device(cookie, 'Tools PC')
    await enable(cookie, {})
    await upload(key, { seen: ['codex', 'opencode', 'not-a-tool'], tools: ['codex'], days: [{ day, rows: [codexRow(100)] }] })
    const tools = await (await call('/api/tools', { cookie })).json<{ tool: string; enabled: boolean; devices: unknown[] }[]>()
    expect(tools.find((t) => t.tool === 'codex')).toMatchObject({ enabled: false })
    expect(tools.find((t) => t.tool === 'codex')!.devices.length).toBeGreaterThan(0)
    expect(tools.some((t) => t.tool === 'not-a-tool')).toBe(false)
    expect(await env.DB.prepare('SELECT count(*) n FROM tool_daily WHERE tool = ?').bind('codex').first('n')).toBe(0)
  })

  it('replaces a day snapshot instead of adding to it, and prices it on the server', async () => {
    const cookie = await owner()
    const key = await device(cookie, 'Tools Mac')
    await enable(cookie, { codex: true })
    await upload(key, { tools: ['codex'], days: [{ day, rows: [codexRow(100)] }] })
    await upload(key, { tools: ['codex'], days: [{ day, rows: [codexRow(500_000)] }] }) // same day again, more output
    const devices = await (await call('/api/devices', { cookie })).json<{ id: string; name: string }[]>()
    const id = devices.filter((d) => d.name === 'Tools Mac').at(-1)!.id
    const r = await (await call(`/api/overview?from=2026-10-01&to=2026-10-03&device=${id}`, { cookie })).json<any>()
    expect(r.by.tool).toEqual([expect.objectContaining({ key: 'codex', out_tok: 500_000, in_tok: 1_000_000, turns: 3 })])
    // gpt-6.1-sol: $2 / M input, $10 / M output.
    expect(r.totals.cost).toBeCloseTo(2 + 5, 6)
    // Filtering to Claude Code hides other tools; filtering by account (a Claude-only idea) does too.
    const claudeOnly = await (await call(`/api/overview?from=2026-10-01&to=2026-10-03&device=${id}&tool=claude`, { cookie })).json<any>()
    expect(claudeOnly.totals.tokens).toBe(0)
    const byAccount = await (await call(`/api/overview?from=2026-10-01&to=2026-10-03&device=${id}&account=x`, { cookie })).json<any>()
    expect(byAccount.by.tool).toEqual([])
    // Deleting the device removes its tool data too, even with no Claude data at all.
    const del = await (await call('/api/data/delete', { json: { scope: 'device', id }, cookie })).json<{ deleted: boolean }>()
    expect(del.deleted).toBe(true)
    expect(await env.DB.prepare('SELECT count(*) n FROM tool_daily WHERE device_id = ?').bind(id).first('n')).toBe(0)
  })

  it('a device setting can turn a tool off for that device only', async () => {
    const cookie = await owner()
    const key = await device(cookie, 'Shared PC')
    const cfg = await (await call('/api/v1/config', { key })).json<{ device_id: string }>()
    await enable(cookie, { opencode: true })
    await call(`/api/settings/device/${cfg.device_id}`, { method: 'PUT', json: { tools: { opencode: false } }, cookie })
    const r = await (await upload(key, { tools: ['opencode'], days: [{ day, rows: [{ ...codexRow(1), tool: 'opencode', model: 'big-pickle' }] }] })).json<{ stored_tools: string[] }>()
    expect(r.stored_tools).toEqual([])
  })

  it('serves pinned tokscale packages only', async () => {
    for (const p of ['/dl/tokscale/latest/cli-darwin-arm64.tgz', '/dl/tokscale/4.17.0/cli-evil.tgz', '/dl/tokscale/4.17.0/..%2Fx']) expect((await call(p)).status).toBe(404)
  })
})

describe('health from the app and the tracker', () => {
  it('merges both reports and stamps who sent each', async () => {
    const cookie = await owner()
    const key = await device(cookie, 'Merge PC')
    expect((await call('/api/v1/health', { json: { app: '1.6.0', disk_free: 5, disk_total: 10 }, key })).status).toBe(200)
    expect((await call('/api/v1/health', { json: { from: 'tracker', agent: '1.6.0', app_running: false, hooks: 'user' }, key })).status).toBe(200)
    const list = await (await call('/api/devices', { cookie })).json<{ name: string; health: Record<string, unknown> }[]>()
    const h = list.find((d) => d.name === 'Merge PC')!.health
    expect(h).toMatchObject({ app: '1.6.0', disk_free: 5, agent: '1.6.0', app_running: false, hooks: 'user' })
    expect(typeof h.app_at).toBe('number')
    expect(typeof h.tracker_at).toBe('number')
    expect(h.from).toBeUndefined()
  })
})

describe('joining again', () => {
  it('keeps the same device (history, sessions) when the computer proves it with its previous key', async () => {
    const cookie = await owner()
    const join = async (previous?: { device_id: string; device_key: string }) => {
      const { code } = await (await call('/api/devices/enroll', { json: { name: 'Rejoin Mac' }, cookie })).json<{ code: string }>()
      return (await call('/api/v1/enroll', { json: { code, os: 'darwin', arch: 'arm64', agent_version: '1.6.0', previous } })).json<{ device_id: string; device_key: string }>()
    }
    const first = await join()
    const again = await join(first)
    expect(again.device_id).toBe(first.device_id)
    expect(again.device_key).not.toBe(first.device_key)
    expect((await call('/api/v1/config', { key: first.device_key })).status).toBe(401) // old key retired
    expect((await call('/api/v1/config', { key: again.device_key })).status).toBe(200)
    const devices = await (await call('/api/devices', { cookie })).json<{ name: string }[]>()
    expect(devices.filter((d) => d.name === 'Rejoin Mac').length).toBe(1)
    // A wrong previous key: a new device, nothing taken over.
    const other = await join({ device_id: first.device_id, device_key: 'not-the-key' })
    expect(other.device_id).not.toBe(first.device_id)
  })
})
