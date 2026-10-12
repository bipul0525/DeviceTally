import type { Context, MiddlewareHandler } from 'hono'
import { getCookie, setCookie, deleteCookie } from 'hono/cookie'
import { hashPassword, randomToken, sha256, verifyPassword } from './crypto'

export type Env = { Bindings: { DB: D1Database; SETUP_TOKEN?: string; RELEASE_REPO?: string; HOST?: string }; Variables: { deviceId: string } }

const COOKIE = 'dt_session'
const SESSION_MS = 30 * 24 * 3600_000
const DAY_MS = 24 * 3600_000

async function startSession(c: Context<Env>) {
  const token = randomToken()
  const now = Date.now()
  await c.env.DB.prepare('INSERT INTO auth_sessions (id_hash, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), now, now + SESSION_MS, c.req.header('user-agent') ?? null)
    .run()
  setCookie(c, COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: SESSION_MS / 1000 })
}

export async function setup(c: Context<Env>) {
  const { token, email, password, timezone } = await c.req.json<Record<string, string>>()
  if (!c.env.SETUP_TOKEN || token !== c.env.SETUP_TOKEN) return c.json({ error: 'bad_setup_token' }, 403)
  if (!email?.includes('@') || !password || password.length < 10) return c.json({ error: 'weak_credentials' }, 400)
  // id = 1 CHECK + OR IGNORE: only the first setup can ever succeed.
  const r = await c.env.DB.prepare('INSERT OR IGNORE INTO owner (id, email, password_hash, timezone, created_at) VALUES (1, ?, ?, ?, ?)')
    .bind(email.toLowerCase(), await hashPassword(password), timezone || 'UTC', Date.now())
    .run()
  if (!r.meta.changes) return c.json({ error: 'already_set_up' }, 409)
  await startSession(c)
  return c.json({ ok: true })
}

export async function login(c: Context<Env>) {
  const { email, password } = await c.req.json<Record<string, string>>()
  const owner = await c.env.DB.prepare('SELECT email, password_hash, failed_logins, locked_until FROM owner WHERE id = 1')
    .first<{ email: string; password_hash: string; failed_logins: number; locked_until: number | null }>()
  const now = Date.now()
  if (!owner) return c.json({ error: 'not_set_up' }, 409)
  if (owner.locked_until && owner.locked_until > now) return c.json({ error: 'locked', retry_at: owner.locked_until }, 429)
  if (email?.toLowerCase() === owner.email && (await verifyPassword(password ?? '', owner.password_hash))) {
    await c.env.DB.prepare('UPDATE owner SET failed_logins = 0, locked_until = NULL WHERE id = 1').run()
    await startSession(c)
    return c.json({ ok: true })
  }
  // After 5 failures: lock 1, 2, 4 ... minutes, at most 1 hour.
  const failed = owner.failed_logins + 1
  const lock = failed >= 5 ? now + Math.min(60, 2 ** (failed - 5)) * 60_000 : null
  await c.env.DB.prepare('UPDATE owner SET failed_logins = ?, locked_until = ? WHERE id = 1').bind(failed, lock).run()
  return c.json({ error: 'bad_credentials' }, 401)
}

export async function logout(c: Context<Env>) {
  const token = getCookie(c, COOKIE)
  if (token) await c.env.DB.prepare('DELETE FROM auth_sessions WHERE id_hash = ?').bind(await sha256(token)).run()
  deleteCookie(c, COOKIE, { path: '/' })
  return c.json({ ok: true })
}

export async function logoutEverywhere(c: Context<Env>) {
  await c.env.DB.prepare('DELETE FROM auth_sessions').run()
  deleteCookie(c, COOKIE, { path: '/' })
  return c.json({ ok: true })
}

/** Dashboard routes: valid session cookie. Extends the session at most once a day (saves writes). */
export const requireOwner: MiddlewareHandler<Env> = async (c, next) => {
  const token = getCookie(c, COOKIE)
  if (!token) return c.json({ error: 'unauthenticated' }, 401)
  const idHash = await sha256(token)
  const now = Date.now()
  const s = await c.env.DB.prepare('SELECT expires_at FROM auth_sessions WHERE id_hash = ?').bind(idHash).first<{ expires_at: number }>()
  if (!s || s.expires_at < now) return c.json({ error: 'unauthenticated' }, 401)
  if (s.expires_at - now < SESSION_MS - DAY_MS) {
    await c.env.DB.prepare('UPDATE auth_sessions SET expires_at = ? WHERE id_hash = ?').bind(now + SESSION_MS, idHash).run()
    setCookie(c, COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Strict', path: '/', maxAge: SESSION_MS / 1000 })
  }
  await next()
}

/** Agent routes: `Authorization: Bearer <device key>`, not revoked. */
export const requireDevice: MiddlewareHandler<Env> = async (c, next) => {
  const key = c.req.header('authorization')?.replace(/^Bearer /, '')
  if (!key) return c.json({ error: 'unauthenticated' }, 401)
  const d = await c.env.DB.prepare('SELECT id FROM devices WHERE key_hash = ? AND revoked_at IS NULL')
    .bind(await sha256(key))
    .first<{ id: string }>()
  if (!d) return c.json({ error: 'unauthenticated' }, 401)
  c.set('deviceId', d.id)
  await next()
}
