// The DeviceTally server outside Cloudflare (Docker, a VPS, a home server, Railway, Fly.io…): the
// same app as the Worker, on Node with its data in one SQLite file. Settings come from the
// environment: PORT (8787), DATA_DIR (./data), SETUP_TOKEN, RELEASE_REPO.
import { serve } from '@hono/node-server'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import worker from './index'
import { randomToken } from './crypto'
import { nightly } from './nightly'
import { SqliteD1 } from './sqlite'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = process.env.DATA_DIR || join(process.cwd(), 'data')
mkdirSync(dataDir, { recursive: true })
const db = new SqliteD1(join(dataDir, 'devicetally.db'))
const migrations = process.env.MIGRATIONS_DIR || [join(here, 'migrations'), join(here, '..', 'migrations')].find(existsSync)!
const applied = db.migrate(migrations)
if (applied.length) console.log(`Database updated: ${applied.join(', ')}`)

// The one-time setup token: from the environment, or made once and kept next to the database.
let setupToken = process.env.SETUP_TOKEN
if (!setupToken) {
  const file = join(dataDir, 'setup-token')
  if (!existsSync(file)) writeFileSync(file, randomToken(18), { mode: 0o600 })
  setupToken = readFileSync(file, 'utf8').trim()
}
const owned = db.prepare('SELECT 1 FROM owner WHERE id = 1').exec().results.length > 0

const env = { DB: db as unknown as D1Database, HOST: 'node', SETUP_TOKEN: setupToken, RELEASE_REPO: process.env.RELEASE_REPO || 'bipul0525/devicetally' }
const ctx = { waitUntil: (p: Promise<unknown>) => void p.catch((e) => console.error(e)), passThroughOnException() {}, props: {} } as unknown as ExecutionContext

const port = Number(process.env.PORT) || 8787
serve({
  port,
  fetch: (req, info) => {
    // The client's address for the join rate limit: the one the nearest proxy saw, else the
    // connection's. A client can't choose it by sending the header itself.
    const fwd = req.headers.get('x-forwarded-for')?.split(',').pop()?.trim()
    const headers = new Headers(req.headers)
    headers.set('cf-connecting-ip', fwd || (info as { incoming?: { socket?: { remoteAddress?: string } } }).incoming?.socket?.remoteAddress || 'unknown')
    return worker.fetch(new Request(req, { headers }), env, ctx)
  },
})
console.log(`DeviceTally server on port ${port}, data in ${dataDir}`)
if (!owned) console.log(`Not set up yet. In the DeviceTally app: Sign in as admin, tick "First time on this server", setup token: ${setupToken}`)

// Nightly upkeep at 03:17 UTC, like the Worker's cron.
function scheduleNightly() {
  const next = new Date()
  next.setUTCHours(3, 17, 0, 0)
  if (next.getTime() <= Date.now()) next.setUTCDate(next.getUTCDate() + 1)
  setTimeout(() => nightly(env.DB).catch((e) => console.error(e)).finally(scheduleNightly), next.getTime() - Date.now())
}
scheduleNightly()
