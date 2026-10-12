// Stands in for 'cloudflare:test' when the tests run on Node (vitest.node.config.ts): the same
// server and tests, with the database in SQLite instead of D1.
import worker from '../src/index'
import { SqliteD1 } from '../src/sqlite'

const db = new SqliteD1(':memory:')
export const env = { DB: db as unknown as D1Database, SETUP_TOKEN: 'test-setup-token', RELEASE_REPO: 'me/devicetally', TEST_MIGRATIONS: new URL('../migrations', import.meta.url).pathname }
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext
export const SELF = { fetch: (url: string, init?: RequestInit) => worker.fetch(new Request(url, init), env, ctx) }
export const applyD1Migrations = async (d: D1Database, dir: string) => { (d as unknown as SqliteD1).migrate(dir) }
