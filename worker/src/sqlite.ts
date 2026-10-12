// D1's interface over a SQLite file (Node's built-in node:sqlite), so the same server runs outside
// Cloudflare: Docker, a VPS, a home server. Only what DeviceTally uses: prepare/bind, first, all,
// run, batch (in one transaction, like D1) and exec (migrations).
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// D1 turns booleans into 1/0 and undefined into NULL; node:sqlite rejects both.
const value = (v: unknown): SQLInputValue => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : (v as SQLInputValue))

class Statement {
  constructor(private db: SqliteD1, readonly sql: string, private params: SQLInputValue[] = []) {}
  bind(...params: unknown[]) {
    return new Statement(this.db, this.sql, params.map(value))
  }
  private stmt(): StatementSync {
    return this.db.raw.prepare(this.sql)
  }
  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.stmt().get(...this.params) as Record<string, unknown> | undefined
    if (!row) return null
    return (column ? (row[column] ?? null) : { ...row }) as T
  }
  async all<T = Record<string, unknown>>() {
    return this.exec<T>()
  }
  async run<T = Record<string, unknown>>() {
    return this.exec<T>()
  }
  /** Rows for a query, changes for a write: the D1 result shape either way. */
  exec<T>() {
    const s = this.stmt()
    if (s.columns().length) {
      const results = s.all(...this.params).map((r) => ({ ...r })) as T[]
      return { success: true as const, results, meta: { changes: 0, last_row_id: 0, size_after: this.db.size() } }
    }
    const r = s.run(...this.params)
    return { success: true as const, results: [] as T[], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid), size_after: this.db.size() } }
  }
}

export class SqliteD1 {
  readonly raw: DatabaseSync
  constructor(path: string) {
    this.raw = new DatabaseSync(path)
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
  }
  prepare(sql: string) {
    return new Statement(this, sql)
  }
  async batch(stmts: Statement[]) {
    this.raw.exec('BEGIN')
    try {
      const out = stmts.map((s) => s.exec())
      this.raw.exec('COMMIT')
      return out
    } catch (e) {
      this.raw.exec('ROLLBACK')
      throw e
    }
  }
  async exec(sql: string) {
    this.raw.exec(sql)
    return { count: 0, duration: 0 }
  }
  size() {
    const r = this.raw.prepare('SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()').get() as { n: number }
    return Number(r.n)
  }
  /** Applies migrations/*.sql not applied yet, in order, each in a transaction (forward-only). */
  migrate(dir: string) {
    this.raw.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT DEFAULT CURRENT_TIMESTAMP)')
    const done = new Set((this.raw.prepare('SELECT name FROM d1_migrations').all() as { name: string }[]).map((r) => r.name))
    const applied: string[] = []
    for (const name of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(name)) continue
      this.raw.exec('BEGIN')
      try {
        this.raw.exec(readFileSync(join(dir, name), 'utf8'))
        this.raw.prepare('INSERT INTO d1_migrations (name) VALUES (?)').run(name)
        this.raw.exec('COMMIT')
        applied.push(name)
      } catch (e) {
        this.raw.exec('ROLLBACK')
        throw new Error(`migration ${name}: ${(e as Error).message}`)
      }
    }
    return applied
  }
}
