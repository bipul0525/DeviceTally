// The main window (replaces the web dashboard). Compact, native-looking, concise.
// Admin: everything, with prompt text only behind Settings → Prompts. A connected machine: its own
// tokens and session times only (no prompts, no titles, no other devices).
import { invoke } from '@tauri-apps/api/core'
import { disable, enable, isEnabled } from '@tauri-apps/plugin-autostart'
import { Fragment, type ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { listen } from '@tauri-apps/api/event'
import { OpenLink, Onboarding, SignIn, TOKEN_URL } from './onboarding'
import { Mark, modelName } from './brands'
import { AppGroup } from './updates'

const api = <T,>(path: string, method = 'GET', body?: unknown) => invoke<T>('api', { method, path, body: body ?? null })

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 })
const whole = new Intl.NumberFormat('en')
export const fmt = (n: number) => (n < 10_000 ? whole.format(n) : compact.format(n))
const usd = (n: number) => new Intl.NumberFormat('en', { style: 'currency', currency: 'USD' }).format(n)
const dur = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m` : s >= 60 ? `${Math.floor(s / 60)}m` : `${Math.round(s)}s`)
const when = (ts: number) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const time = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
// Device health from "last seen": computers with the app check in every 5 minutes.
const health = (ts: number | null): { state: 'online' | 'idle' | 'offline'; text: string } => {
  if (!ts) return { state: 'offline', text: 'Never checked in' }
  const m = (Date.now() - ts) / 60000
  if (m < 15) return { state: 'online', text: 'Online' }
  if (m < 1440) return { state: 'idle', text: `Idle · seen ${ago(ts)}` }
  return { state: 'offline', text: `Offline for ${Math.round(m / 1440)} d` }
}
/** Online / idle / offline from the last contact. With `appAt`, an online computer whose app
 *  hasn't reported for 15 minutes (only the tracker's background check-in comes) says "app closed". */
const Health = ({ ts, appAt }: { ts: number | null; appAt?: number | null }) => {
  const h = health(ts)
  const appClosed = appAt != null && h.state !== 'offline' && Date.now() - appAt > 15 * 60_000
  return <span class={`health ${appClosed ? 'idle' : h.state}`} title={(ts ? `Last seen ${new Date(ts).toLocaleString()}` : 'Never seen') + (appClosed ? ` · the DeviceTally app last ran ${new Date(appAt!).toLocaleString()}; usage still arrives` : '')}><i />{h.text}{appClosed ? ' · app closed' : ''}</span>
}
const ago = (ts: number | null) => {
  if (!ts) return 'never'
  const m = (Date.now() - ts) / 60000
  return m < 2 ? 'now' : m < 60 ? `${Math.round(m)} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`
}

const SHAPES = [
  <circle cx="6" cy="6" r="5" />, <path d="M6 1l5 9H1z" />, <rect x="1.5" y="1.5" width="9" height="9" rx="1" />,
  <path d="M6 .8l5.2 5.2L6 11.2.8 6z" />, <circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" stroke-width="2.4" />,
  <rect x="1" y="3.5" width="10" height="5" rx="1" />,
]
export const Chip = ({ i }: { i: number }) => <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">{SHAPES[Math.max(0, i) % 6]}</svg>

type Status = { server: string; signed_in: boolean; this_device_connected: boolean; agent_server: string; local?: boolean }

function useLoad<T>(path: string | null, deps: unknown[] = []) {
  const [s, set] = useState<{ data?: T; error?: string }>({})
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!path) return
    let live = true
    set((x) => ({ data: x.data }))
    api<T>(path).then((data) => live && set({ data }), (e) => live && set({ error: String(e) }))
    return () => { live = false }
  }, [path, n, ...deps])
  return { ...s, reload: () => setN((x) => x + 1) }
}

/** A plain explanation of an error code from the app or the server: what happened, what to do. */
export function explain(error: string): { title: string; detail: string; link?: [string, string] } {
  if (error === 'offline') return { title: 'Can’t reach your server', detail: 'Check the internet connection. Usage keeps being recorded on each computer and uploads when the server is reachable.' }
  if (error === 'db_limit') {
    const reset = new Date(); reset.setUTCHours(24, 0, 0, 0)
    return {
      title: 'Your server reached today’s free limit',
      detail: `Cloudflare’s free plan pauses the database until midnight UTC: ${reset.getDate() !== new Date().getDate() ? 'tomorrow ' : 'today '}at ${reset.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}, in about ${Math.max(1, Math.round((reset.getTime() - Date.now()) / 3600_000))} hour${Math.round((reset.getTime() - Date.now()) / 3600_000) === 1 ? '' : 's'}. Nothing is lost: each computer keeps its usage and uploads it then.`,
      link: ['Raise the limit (Workers Paid, $5/month)', 'https://dash.cloudflare.com/?to=/:account/workers/plans'],
    }
  }
  if (error === 'server_404') return { title: 'Your server needs an update', detail: 'This screen needs a newer server. See Settings → Server.' }
  if (/^server_5\d\d$|^server_error$/.test(error)) return { title: 'Your server had a problem', detail: 'It’s usually temporary. Try again in a minute; if it keeps happening, update the server (Settings → Server).' }
  return { title: 'Could not load this', detail: error }
}

/** Shown above this computer's own count when the server couldn't answer. */
export function FallbackNote({ error }: { error: string }) {
  const e = explain(error)
  return <div class="note fallback-note" role="status" title={e.detail}><span class="note-ic warn" aria-hidden="true" /><span><b>{e.title}.</b> Showing this computer's own count (no cost estimate) until it's back.</span></div>
}

export function ErrorState({ error, retry }: { error: string; retry: () => void }) {
  const e = explain(error)
  return (
    <div class="state err-state" role="alert">
      <span class={`err-ic ${error === 'db_limit' ? 'wait' : ''}`} aria-hidden="true">{error === 'db_limit' ? '⏳' : error === 'offline' ? '⚡︎' : '!'}</span>
      <strong>{e.title}</strong>
      <span>{e.detail}</span>
      <span class="err-actions">
        <button class="btn" onClick={retry}>Try again</button>
        {e.link && <button class="link-btn" onClick={() => import('@tauri-apps/plugin-opener').then((m) => m.openUrl(e.link![1]))}>{e.link[0]}</button>}
      </span>
    </div>
  )
}

function Load<T>({ q, children }: { q: ReturnType<typeof useLoad<T>>; children: (d: T) => ComponentChildren }) {
  if (q.error) {
    return (
      <ErrorState error={q.error} retry={q.reload} />
    )
  }
  if (!q.data) return <div aria-label="Loading" class="section"><div class="skel" style={{ height: 30, width: '50%' }} /><div class="skel" style={{ height: 12, width: '70%' }} /></div>
  return <>{children(q.data)}</>
}

function Bars({ items, max }: { items: { key: string; label: ComponentChildren; value: number; text: string }[]; max?: number }) {
  if (!items.length) return <p class="hint">Nothing in this range.</p>
  const m = max ?? Math.max(1, ...items.map((i) => i.value))
  return (
    <>
      {items.map((i) => (
        <div class="row" key={i.key}>
          <span class="name">{i.label}</span><span class="val num">{i.text}</span>
          <div class="track" aria-hidden="true"><div style={{ width: `${(i.value / m) * 100}%` }} /></div>
        </div>
      ))}
    </>
  )
}

const RANGES = [['1', 'Today'], ['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['365', '12 months']] as const

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void; label: string }) {
  return (
    <div class="seg" role="group" aria-label={label} style={{ gridTemplateColumns: `repeat(${options.length}, 1fr)` }}>
      {options.map(([k, l]) => <button key={k} aria-pressed={value === k} onClick={() => onChange(k)}>{l}</button>)}
    </div>
  )
}

// ---------- Overview ----------
type Totals = { tokens: number; cost: number; turns: number; sessions: number; active_seconds: number; prompts: number }
type Overview = {
  totals: Totals; previous: Totals
  daily: ({ day: string } & Totals)[]
  by: Record<'device' | 'model' | 'tool' | 'project', ({ key: string } & Totals)[]>
  labels: { devices: { id: string; name: string }[]; projects: { key: string; display_name: string | null }[]; tools: Record<string, string>; tools_seen: string[] }
}

const PALETTE = ['#0a84ff', '#30d158', '#ff9f0a', '#bf5af2', '#ff375f', '#64d2ff', '#ffd60a', '#ac8e68']

/** Tokens per day: one bar per day, split by device (colours), with a scale and dates. */
function DailyChart({ days, series }: { days: { day: string; tokens: number }[]; series: { name: string; daily: Map<string, number> }[] | null }) {
  const W = 1000, H = 200, L = 52, B = 22, T = 8
  const max = Math.max(1, ...days.map((d) => d.tokens))
  const step = (W - L) / Math.max(1, days.length)
  const bw = Math.max(1, step * 0.72)
  const y = (v: number) => H - B - (v / max) * (H - B - T)
  const every = Math.max(1, Math.ceil(days.length / 8))
  const label = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const stacks = series && series.length > 1
  return (
    <div class="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Tokens per day">
        <g class="grid">
          {[0, 0.5, 1].map((f) => <g key={f}><line x1={L} x2={W} y1={y(max * f)} y2={y(max * f)} /><text x={L - 8} y={y(max * f) + 3} text-anchor="end">{fmt(Math.round(max * f))}</text></g>)}
        </g>
        {days.map((d, i) => {
          const x = L + i * step + (step - bw) / 2
          let acc = 0
          const parts = stacks ? series!.map((s, k) => ({ k, name: s.name, v: s.daily.get(d.day) ?? 0 })).filter((p) => p.v > 0) : [{ k: 0, name: '', v: d.tokens }]
          return (
            <g key={d.day}>
              {parts.map((p) => {
                const top = y(acc + p.v), h = y(acc) - top
                acc += p.v
                return <rect key={p.k} x={x} y={top} width={bw} height={Math.max(0, h)} rx={Math.min(2, bw / 4)} fill={PALETTE[p.k % PALETTE.length]}><title>{`${label(d.day)}${p.name ? ` · ${p.name}` : ''}: ${fmt(p.v)} tokens`}</title></rect>
              })}
              {i % every === 0 && <text x={x + bw / 2} y={H - 6} text-anchor="middle">{label(d.day)}</text>}
            </g>
          )
        })}
      </svg>
      {stacks && <div class="legend">{series!.map((s, k) => <span key={s.name}><i style={{ background: PALETTE[k % PALETTE.length] }} />{s.name}</span>)}</div>}
    </div>
  )
}

type DeviceUsage = { id: string; name: string; os: string | null; chip: number; today: number; week: number; month: number; active_week: number; last_active: number | null; last_prompt: number | null; last_seen: number | null }

/** Online on a weekday afternoon with no usage today, though it normally has plenty: usage may be
 * happening where DeviceTally can't see it. Only a hint. */
function quiet(d: DeviceUsage): boolean {
  const now = new Date()
  const day = now.getDay()
  return day > 0 && day < 6 && now.getHours() >= 14 && d.today === 0 && d.month / 30 > 200_000
    && health(d.last_seen).state !== 'offline' && Date.now() - (d.last_seen ?? 0) < 30 * 60_000
}

// Admin: every computer side by side, so it's clear which one uses how much. Click to filter.
function DevicesAtGlance({ selected, select }: { selected: string; select: (id: string) => void }) {
  // One tokens column with a range picker, instead of Today / 7 days / 30 days side by side.
  const [span, setSpan] = useState<'today' | 'week' | 'month'>(() => { try { return (localStorage.getItem('dt-glance') as 'today' | 'week' | 'month') || 'week' } catch { return 'week' } })
  const q = useLoad<DeviceUsage[]>('/device-usage')
  const devs = useLoad<Device[]>('/devices')
  // Tracking problems reported by a computer's app (details under Devices).
  const problems = (devs.data ?? []).filter((d) => !d.revoked_at && d.health).flatMap((d) => {
    const h = d.health!
    const out: string[] = []
    if (h.hooks === 'missing') out.push(`${d.name}: Claude Code tracking hooks are missing`)
    if (h.paused) out.push(`${d.name}: tracking is paused`)
    if (h.server_blocked) out.push(`${d.name}: DeviceTally's server is blocked in its hosts file${h.hosts_changed_at ? ` (edited ${ago(h.hosts_changed_at)})` : ''}; usage still gets through`)
    else if (h.hosts_lines?.length) out.push(`${d.name}: its hosts file sends DeviceTally's server to another address (${h.hosts_lines.join(' | ')})`)
    if (h.dns_routed && !h.server_blocked) out.push(`${d.name}: DNS on this computer or its network blocks DeviceTally's server; usage still gets through`)
    const events = (h.events ?? []).filter((e) => notable(e) && Date.now() - e.at < 7 * 86400_000).length
    if (events) out.push(`${d.name}: ${events} tracking event${events > 1 ? 's' : ''} in the last 7 days (see Devices)`)
    const removed = (h.removed ?? []).filter((r) => Date.now() - r.at < 7 * 86400_000).length
    if (removed) out.push(`${d.name}: ${removed} Claude Code transcript${removed > 1 ? 's were' : ' was'} deleted before upload`)
    if (!h.locked && h.config_dirs?.length) out.push(`${d.name}: Claude Code has another settings folder that isn't tracked`)
    if (d.disk_full_in_days != null && d.disk_full_in_days < 14) out.push(`${d.name}: disk full in about ${d.disk_full_in_days} days`)
    return out
  })
  return (
    <section class="section"><h2>Devices</h2>
      <Load q={q}>
        {(rows) => (<>
          {(problems.length > 0 || rows.some(quiet) || rows.some((d) => health(d.last_seen ?? d.last_active).state === 'offline')) && (
            <div class="notes" role="status">
              {rows.filter((d) => health(d.last_seen ?? d.last_active).state === 'offline').map((d) => {
                const h = devs.data?.find((x) => x.id === d.id)?.health
                const why = h?.server_blocked || h?.hosts_lines?.length ? ' · its hosts file names the DeviceTally server' : h?.hooks === 'missing' ? ' · its tracking hooks were missing' : h?.paused ? ' · tracking was paused' : ''
                return (
                  <div key={d.id} class="note">
                    <span class="note-ic off" aria-hidden="true" />
                    <span title="Nothing from its app or tracker. It may be switched off, offline, or DeviceTally was removed from it."><b>{d.name}</b> isn't reporting · last heard from {ago(d.last_seen ?? d.last_active)}{why}</span>
                  </div>
                )
              })}
              {rows.filter(quiet).map((d) => (
                <div key={'q' + d.id} class="note">
                  <span class="note-ic warn" aria-hidden="true" />
                  <span title="Online, but no usage reached DeviceTally today. Claude Code may be running from a folder, user account or virtual machine DeviceTally doesn't see, or the transcripts were removed."><b>{d.name}</b> · online but no usage today (usually about {fmt(d.month / 30)} a day)</span>
                </div>
              ))}
              {problems.map((p) => (
                <div key={p} class="note">
                  <span class="note-ic warn" aria-hidden="true" />
                  <span><b>{p.split(': ')[0]}</b> · {p.split(': ').slice(1).join(': ')}</span>
                </div>
              ))}
            </div>
          )}
          <table class="list glance">
            <colgroup><col style={{ width: '30%' }} /><col style={{ width: '32%' }} /><col style={{ width: '18%' }} /><col style={{ width: '20%' }} /></colgroup>
            <thead><tr><th>Device</th><th>Status</th>
              <th class="r"><select class="th-pick" aria-label="Tokens for" value={span} onChange={(e) => { const v = e.currentTarget.value as typeof span; setSpan(v); try { localStorage.setItem('dt-glance', v) } catch { /* fine */ } }}>
                <option value="today">Tokens today</option><option value="week">Tokens · 7 days</option><option value="month">Tokens · 30 days</option></select></th>
              <th>Last prompt</th></tr></thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} tabIndex={0} aria-selected={selected === d.id} class={selected === d.id ? 'selected' : ''}
                  onClick={() => select(selected === d.id ? '' : d.id)} onKeyDown={(e) => e.key === 'Enter' && select(selected === d.id ? '' : d.id)}>
                  <td><span class="name"><Chip i={d.chip} /> {d.name}</span></td>
                  <td><Health ts={d.last_seen ?? d.last_active} /></td>
                  <td class="r num" title={`Active ${dur(d.active_week)} in the last 7 days · last active ${ago(d.last_active ?? d.last_seen)}`}>{fmt(span === 'today' ? d.today : span === 'week' ? d.week : d.month)}</td>
                  <td class="muted">{ago(d.last_prompt)}</td>
                </tr>
              ))}
            </tbody>
          </table></>
        )}
      </Load>
      {selected && <p class="hint" style={{ margin: 0 }}>Showing one device below. <button class="link-btn" onClick={() => select('')}>Show all</button></p>}
    </section>
  )
}

function OverviewTab({ admin }: { admin: boolean }) {
  const [range, setRange] = useState<(typeof RANGES)[number][0]>('30')
  const [tool, setTool] = useState('')
  const [device, setDevice] = useState('')
  const q = useLoad<Overview>(`/overview?days=${range}${tool ? `&tool=${tool}` : ''}${device ? `&device=${device}` : ''}`)
  // Admin, all devices: each device's own daily totals, for the stacked chart.
  const [series, setSeries] = useState<{ name: string; daily: Map<string, number> }[] | null>(null)
  const devs = q.data?.labels.devices ?? []
  useEffect(() => {
    setSeries(null)
    if (!admin || device || devs.length < 2) return
    let live = true
    Promise.all(devs.map((d) => api<Overview>(`/overview?days=${range}${tool ? `&tool=${tool}` : ''}&device=${d.id}`)
      .then((o) => ({ name: d.name, daily: new Map(o.daily.map((x) => [x.day, x.tokens])) }))))
      .then((s) => live && setSeries(s), () => {})
    return () => { live = false }
  }, [admin, device, range, tool, devs.map((d) => d.id).join()])
  const devIndex = (id: string) => q.data?.labels.devices.findIndex((d) => d.id === id) ?? 0
  return (
    <div class="page">
      {admin && <DevicesAtGlance selected={device} select={setDevice} />}
      <div class="toolbar">
        <Seg label="Range" value={range} options={RANGES} onChange={setRange} />
        {q.data && !(q.data as { local?: boolean }).local && q.data.labels.tools_seen.length > 0 && (
          <select aria-label="Tool" value={tool} onChange={(e) => setTool(e.currentTarget.value)}>
            <option value="">All tools</option>
            {['claude', ...q.data.labels.tools_seen].map((t) => <option key={t} value={t}>{q.data!.labels.tools[t] ?? t}</option>)}
          </select>
        )}
        {admin && q.data && q.data.labels.devices.length > 1 && (
          <select aria-label="Device" value={device} onChange={(e) => setDevice(e.currentTarget.value)}>
            <option value="">All devices</option>
            {q.data.labels.devices.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        )}
      </div>
      <Load q={q}>
        {(d) => {
          const t = d.totals
          const change = d.previous.tokens ? Math.round(((t.tokens - d.previous.tokens) / d.previous.tokens) * 100) : null
          const fallback = (d as { fallback?: string }).fallback
          return (
            <>
              {fallback && <FallbackNote error={fallback} />}
              <div class="focal">
                <div class="big num">{fmt(t.tokens)} <span style={{ fontSize: 13, fontWeight: 400 }}>tokens</span></div>
                <div class="sub num">
                  {t.cost > 0 && <span title="What this usage would cost at API prices. Subscriptions are a flat fee.">{usd(t.cost)} API-equivalent</span>}
                  {change !== null && <span class="trend">{change >= 0 ? '+' : ''}{change}% vs {range === '1' ? 'yesterday' : `previous ${RANGES.find((r) => r[0] === range)![1]}`}</span>}
                </div>
              </div>
              <div class="stats num">
                <span><b>{fmt(t.sessions)}</b> sessions</span>
                <span><b>{dur(t.active_seconds)}</b> active</span>
                <span><b>{fmt(t.turns)}</b> replies</span>
              </div>
              <DailyChart days={d.daily} series={series} />
              <div class="cols">
                {<section class="section"><h2>By tool</h2>
                  <Bars items={d.by.tool.map((x) => ({ key: x.key, label: <><Mark of={x.key} />{d.labels.tools[x.key] ?? x.key}</>, value: x.tokens, text: fmt(x.tokens) }))} /></section>}
                {<section class="section"><h2>By model</h2>
                  <Bars items={d.by.model.slice(0, 6).map((x) => ({ key: x.key, label: <span title={x.key}><Mark of={x.key} />{modelName(x.key)}</span>, value: x.tokens, text: fmt(x.tokens) }))} /></section>}
                {admin && d.labels.devices.length > 1 && (
                  <section class="section"><h2>By device</h2>
                    <Bars items={d.by.device.map((x) => ({ key: x.key, label: <><Chip i={devIndex(x.key)} />{d.labels.devices.find((v) => v.id === x.key)?.name ?? 'Unknown'}</>, value: x.tokens, text: fmt(x.tokens) }))} /></section>
                )}
                <section class="section"><h2>By project</h2>
                  <Bars items={d.by.project.slice(0, 6).map((x) => ({ key: x.key, label: d.labels.projects.find((p) => p.key === x.key)?.display_name ?? x.key, value: x.tokens, text: fmt(x.tokens) }))} /></section>
              </div>
            </>
          )
        }}
      </Load>
    </div>
  )
}

// ---------- Sessions ----------
type SessionRow = { id: string; device_id: string; project_key: string; title: string | null; started_at: number; ended_at: number; active_seconds: number; tokens: number }
type Detail = {
  session: SessionRow & { entrypoint: string | null }
  prompts: { id: string; ts: number }[]
  turns: { id: string; ts: number; model: string | null; in_tok: number; out_tok: number; cache_write_tok: number; cache_read_tok: number; is_subagent: number; cost: number | null }[]
}

function SessionsTab({ admin }: { admin: boolean }) {
  const [range, setRange] = useState<(typeof RANGES)[number][0]>('30')
  const [open, setOpen] = useState<string | null>(null)
  const q = useLoad<SessionRow[]>(`/sessions?days=${range}`)
  const meta = useLoad<Overview>(`/overview?days=365`)
  const project = (k: string) => meta.data?.labels.projects.find((p) => p.key === k)?.display_name ?? k.replace(/^local\//, '')
  const devices = meta.data?.labels.devices ?? []
  if (open) return <SessionDetail id={open} admin={admin} back={() => setOpen(null)} project={project} devices={devices} />
  return (
    <div class="page">
      <div class="toolbar"><Seg label="Range" value={range} options={RANGES} onChange={setRange} /></div>
      <Load q={q}>
        {(rows) => !rows.length ? <p class="hint">No Claude Code sessions in this range. Sessions are Claude Code only for now: usage from Codex, OpenCode and other tools shows under {admin ? 'Overview' : 'My usage'}.</p> : (
          <table class="list">
            <thead><tr><th>Started</th><th>Project</th>{admin && devices.length > 1 && <th>Device</th>}<th class="r">Active</th><th class="r">Tokens</th></tr></thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} tabIndex={0} onClick={() => setOpen(s.id)} onKeyDown={(e) => e.key === 'Enter' && setOpen(s.id)}>
                  <td class="num">{when(s.started_at)}</td>
                  {/* Titles are written from prompt text, so only the admin sees them. */}
                  <td>{project(s.project_key)}{admin && s.title && <div class="hint" style={{ margin: 0 }}>{s.title}</div>}</td>
                  {admin && devices.length > 1 && <td><span class="name"><Chip i={devices.findIndex((d) => d.id === s.device_id)} /> {devices.find((d) => d.id === s.device_id)?.name}</span></td>}
                  <td class="r num">{dur(s.active_seconds)}</td>
                  <td class="r num">{fmt(s.tokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Load>
    </div>
  )
}

function SessionDetail({ id, admin, back, project, devices }: { id: string; admin: boolean; back: () => void; project: (k: string) => string; devices: { id: string; name: string }[] }) {
  const q = useLoad<Detail>(`/sessions/${encodeURIComponent(id)}`)
  return (
    <div class="page">
      <div class="toolbar"><button class="btn" onClick={back}>‹ Sessions</button></div>
      <Load q={q}>
        {(d) => {
          const s = d.session
          const tok = d.turns.reduce((a, t) => a + t.in_tok + t.out_tok + t.cache_write_tok + t.cache_read_tok, 0)
          const cost = d.turns.reduce((a, t) => a + (t.cost ?? 0), 0)
          // Group replies under the prompt (time only) that preceded them.
          const steps: { at?: number; turns: Detail['turns'] }[] = []
          let pi = 0
          for (const t of d.turns) {
            while (pi < d.prompts.length && d.prompts[pi].ts <= t.ts) steps.push({ at: d.prompts[pi++].ts, turns: [] })
            if (!steps.length) steps.push({ turns: [] })
            steps.at(-1)!.turns.push(t)
          }
          return (
            <>
              <h2 class="title">{admin && s.title ? s.title : project(s.project_key)}</h2>
              <p class="hint" style={{ marginTop: 0 }}>{project(s.project_key)}{devices.length > 1 ? ` · ${devices.find((x) => x.id === s.device_id)?.name ?? ''}` : ''} · {when(s.started_at)}</p>
              <div class="stats num">
                <span><b>{fmt(tok)}</b> tokens</span>{admin && <span><b>{usd(cost)}</b></span>}
                <span><b>{dur(s.active_seconds)}</b> active</span><span><b>{dur((s.ended_at - s.started_at) / 1000)}</b> total</span>
              </div>
              <ol class="timeline">
                {steps.map((st, i) => {
                  const g = st.turns
                  const sum = g.reduce((a, t) => a + t.in_tok + t.out_tok + t.cache_write_tok + t.cache_read_tok, 0)
                  const models = [...new Set(g.map((t) => t.model).filter(Boolean))].join(', ')
                  return (
                    <li key={i}>
                      <span class="num">{st.at ? time(st.at) : time(g[0]?.ts ?? s.started_at)}</span>
                      <span>{g.length} {g.length === 1 ? 'reply' : 'replies'}{admin ? `${g.some((t) => t.is_subagent) ? ' (incl. subagents)' : ''} · ${models}` : ''}</span>
                      <span class="num val">{fmt(sum)}</span>
                    </li>
                  )
                })}
              </ol>
            </>
          )
        }}
      </Load>
    </div>
  )
}

// ---------- Devices (admin) ----------
type Device = { id: string; name: string; os: string | null; arch: string | null; agent_version: string | null; last_seen: number | null; revoked_at: number | null; disconnect_requested_at?: number | null
  health?: DeviceHealth | null; health_at?: number | null; disk_full_in_days?: number | null }
type DeviceHealth = { hooks?: 'locked' | 'user' | 'missing'; locked?: boolean; paused?: boolean; removed?: { path: string; at: number }[]; config_dirs?: string[]; disk_free?: number; disk_total?: number; app?: string; agent?: string; update_error?: string; app_at?: number; tracker_at?: number; app_running?: boolean; server_blocked?: boolean
  hosts_lines?: string[]; hosts_changed_at?: number; dns_routed?: boolean; proxy?: string; events?: DeviceEvent[] }
type DeviceEvent = { at: number; kind: string; text: string }
/** Events worth the admin's attention (a lost internet connection isn't). */
const notable = (e: DeviceEvent) => !e.text.includes('no internet connection')

/** Under each computer in Devices: tracking health, disk, and the projects it's meant for. */
function DeviceDetails({ d, settings, saved }: { d: Device; settings: SettingRow[]; saved: () => void }) {
  const h = d.health
  const own = JSON.parse(settings.find((r) => r.scope === 'device' && r.scope_id === d.id)?.json ?? '{}') as { allowed_projects?: string[]; app_updates?: string; update_now?: number }
  const globalUpdates = (JSON.parse(settings.find((r) => r.scope === 'global')?.json ?? '{}') as { app_updates?: string }).app_updates === 'ask' ? 'ask' : 'auto'
  const [mine, setMine] = useState('')
  useEffect(() => { import('@tauri-apps/api/app').then((m) => m.getVersion()).then(setMine, () => {}) }, [])
  const behind = !!(h?.app && mine && newer(mine, h.app))
  const setDevice = async (patch: Record<string, unknown>) => { await api(`/settings/device/${d.id}`, 'PUT', { ...own, ...patch }); saved() }
  const asked = own.update_now && (!d.health_at || d.health_at < own.update_now + 10 * 60_000) && behind
  const allowed = own.allowed_projects ?? []
  const month = useLoad<Overview>(`/overview?days=30&device=${d.id}`)
  const week = useLoad<Overview>(`/overview?days=7&device=${d.id}`)
  const [editing, setEditing] = useState<string[] | null>(null)
  const name = (k: string) => month.data?.labels.projects.find((p) => p.key === k)?.display_name ?? k.split('/').pop() ?? k
  const outside = allowed.length ? (week.data?.by.project ?? []).filter((p) => p.tokens > 0 && !allowed.includes(p.key)) : []
  const recentRemoved = (h?.removed ?? []).filter((r) => Date.now() - r.at < 7 * 86400_000)
  const save = async () => {
    await api(`/settings/device/${d.id}`, 'PUT', { ...own, allowed_projects: editing })
    setEditing(null); saved()
  }
  const badges: [string, string, string][] = [] // [kind, text, title]
  if (h) {
    badges.push(h.locked ? ['ok', '🔒 Locked', 'Tracking is in Claude Code\'s system-wide settings'] : ['', 'Not locked', 'Settings → Lock this computer, on that computer'])
    if (h.hooks === 'missing') badges.push(['bad', 'Tracking hooks missing', 'Claude Code isn\'t reporting to DeviceTally on this computer'])
    if (h.paused) badges.push(['warn', 'Tracking paused', 'Someone ran "devicetally pause"'])
    const lines = h.hosts_lines?.length ? `\n\nLines:\n${h.hosts_lines.join('\n')}${h.hosts_changed_at ? `\n\nHosts file last changed ${new Date(h.hosts_changed_at).toLocaleString()}` : ''}` : ''
    if (h.server_blocked) badges.push(['bad', 'DeviceTally blocked in the hosts file', 'Someone added a line to this computer\'s hosts file (/etc/hosts) that sends the DeviceTally server\'s address nowhere. Usage still gets through, because DeviceTally routes around it. To remove it, delete the line with the server\'s address from /etc/hosts on that computer (needs its admin password).' + lines])
    else if (h.hosts_lines?.length) badges.push(['bad', 'Server redirected in the hosts file', 'This computer\'s hosts file sends the DeviceTally server\'s name to another address. DeviceTally tries the real address when that one fails.' + lines])
    if (h.dns_routed && !h.server_blocked) badges.push(['bad', 'DNS blocks DeviceTally', 'This computer\'s DNS (or a blocker such as NextDNS, AdGuard or Pi-hole, or the network\'s) gives the server a wrong address or none. Usage still gets through: DeviceTally asks 1.1.1.1 for the real address and checks the server\'s certificate.'])
    if (h.proxy) badges.push(['', 'Uses a proxy', h.proxy])
    if (recentRemoved.length) badges.push(['bad', `${recentRemoved.length} transcript${recentRemoved.length > 1 ? 's' : ''} deleted`, recentRemoved.map((r) => r.path).join('\n')])
    if (h.config_dirs?.length) badges.push([h.locked ? '' : 'warn', `Other Claude settings folder${h.config_dirs.length > 1 ? 's' : ''}${h.locked ? ' (covered by the lock)' : ''}`, h.config_dirs.join('\n')])
  } else badges.push(['', 'No health report yet', 'Reports come from DeviceTally 0.10 or newer on that computer'])
  if (outside.length) badges.push(['bad', `Used outside its projects: ${outside.map((p) => name(p.key)).join(', ')}`, 'In the last 7 days'])
  return (
    <div class="device-details">
      <div class="badges">{badges.map(([k, t, title]) => <span key={t} class={`badge ${k}`} title={title}>{t}</span>)}</div>
      {!!h?.events?.length && (
        <details class="events">
          <summary class="hint">Events ({h.events.length}) · last {ago(h.events[h.events.length - 1].at)}</summary>
          <ul>{[...h.events].reverse().map((e) => <li key={e.at + e.kind}><span class="muted">{new Date(e.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span> <span class={notable(e) ? '' : 'muted'}>{e.text}</span></li>)}</ul>
        </details>
      )}
      <div class="hint" style={{ margin: 0 }}>
        {h?.disk_total ? <>Disk {gbText(h.disk_free ?? 0)} free of {gbText(h.disk_total)}{d.disk_full_in_days != null && <b class={d.disk_full_in_days < 30 ? 'warn' : ''}> · full in about {d.disk_full_in_days < 14 ? `${d.disk_full_in_days} days` : `${Math.round(d.disk_full_in_days / 7)} weeks`}</b>}</> : null}
        {d.health_at ? <> · reported {ago(d.health_at)}</> : null}
        {' · '}Projects: {allowed.length ? allowed.map(name).join(', ') : 'any'} <button class="link-btn" onClick={() => setEditing(allowed)}>Change</button>
      </div>
      <div class="dev-updates">
        <span class={`badge ${behind ? 'warn' : 'ok'}`} title={`App ${h?.app ?? 'unknown'} · tracker ${h?.agent ?? d.agent_version ?? 'unknown'}`}>{h?.app ? `Version ${h.app}${behind ? ` · ${mine} available` : ' · up to date'}` : 'Version unknown'}</span>
        <label class="hint" style={{ margin: 0 }}>Updates <select value={own.app_updates ?? ''} onChange={(e) => { const v = e.currentTarget.value; setDevice({ app_updates: v || undefined }) }}>
          <option value="">Default ({globalUpdates === 'auto' ? 'automatic' : 'ask'})</option><option value="ask">Ask the user</option><option value="auto">Automatic</option></select></label>
        {behind && <button class="btn" disabled={!!asked} title="It updates at its next check-in (within about 5 minutes), when DeviceTally isn't in use there" onClick={() => setDevice({ update_now: Date.now() })}>{asked ? 'Update requested' : 'Update now'}</button>}
        {h?.update_error && <span class="badge bad" title={h.update_error}>Couldn't update: {/permission|denied|not permitted|read-only/i.test(h.update_error) ? 'needs admin rights on that computer' : 'hover for details'}</span>}
      </div>
      {editing && (
        <div class="allowed-editor">
          <span class="hint" style={{ margin: 0 }}>Projects this computer is meant for (used in the last 30 days). Others are flagged; none ticked = any.</span>
          <div class="checks">
            {(month.data?.by.project ?? []).map((p) => (
              <label key={p.key}><input type="checkbox" checked={editing.includes(p.key)} onChange={(e) => setEditing(e.currentTarget.checked ? [...editing, p.key] : editing.filter((x) => x !== p.key))} /> {name(p.key)}</label>
            ))}
            {!month.data?.by.project.length && <span class="hint" style={{ margin: 0 }}>No projects used on this computer yet.</span>}
          </div>
          <span><button class="btn primary" onClick={save}>Save</button> <button class="btn" onClick={() => setEditing(null)}>Cancel</button></span>
        </div>
      )}
    </div>
  )
}
const OS: Record<string, string> = { darwin: 'macOS', linux: 'Linux', windows: 'Windows' }

function DevicesTab({ server }: { server: string }) {
  const q = useLoad<Device[]>('/devices')
  const settings = useLoad<SettingRow[]>('/settings')
  const usage = useLoad<Overview>('/overview?days=30')
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [code, setCode] = useState<string | null>(null)
  const [copied, setCopied] = useState('')
  const [err, setErr] = useState('')
  const live = (q.data ?? []).filter((d) => !d.revoked_at)
  const create = async (e: Event) => {
    e.preventDefault()
    try {
      setCode((await api<{ code: string }>('/devices/enroll', 'POST', { name })).code)
    } catch (x) { setErr(String(x)) }
  }
  // Inline, not prompt()/confirm(): those browser dialogs don't appear in the app window.
  const [edit, setEdit] = useState<{ id: string; mode: 'rename' | 'disconnect'; name: string } | null>(null)
  const act = (fn: () => Promise<unknown>) => async (e?: Event) => {
    e?.preventDefault()
    try { await fn(); setEdit(null); q.reload() } catch (x) { setErr(String(x)) }
  }
  const rename = (d: Device, name: string) => act(() => api(`/devices/${d.id}`, 'PATCH', { name: name.trim() }))
  const revoke = (d: Device) => act(() => api(`/devices/${d.id}`, 'PATCH', { revoked: true }))
  const decline = async (d: Device) => { await api(`/devices/${d.id}`, 'PATCH', { decline_disconnect: true }); q.reload() }
  const copy = (t: string) => navigator.clipboard.writeText(t).then(() => setCopied(t))
  const cmds = code ? [['macOS / Linux', `curl -fsSL ${server}/i/${code} | sh`], ['Windows', `irm ${server}/i/${code} | iex`]] : []
  // A ready-to-send note for the other computer: install the app, then join with these two values.
  const invite = code ? `To add a computer to DeviceTally:
1. Install the app. macOS / Linux, in Terminal:
   curl -fsSL ${server}/app | sh
   Windows: https://github.com/bipul0525/devicetally/releases/latest
2. Open DeviceTally and choose "Join with a code".
   Server address: ${server}
   Code: ${code} (valid 15 minutes)` : ''
  return (
    <div class="page">
      <p class="hint" style={{ marginTop: 0 }}>Online: checked in within 15 minutes. Computers running the DeviceTally app check in every 5 minutes; ones with only the terminal tracker check in when Claude Code is used.</p>
      <div class="toolbar"><span class="hint" style={{ margin: 0 }}>{live.length} connected{live.some((d) => d.disconnect_requested_at) ? ' · a computer asks to be disconnected' : ''}</span><span class="spacer" />
        <button class="btn primary" onClick={() => { setAdding(true); setCode(null); setName('') }}>Add device</button></div>
      {adding && (
        <div class="group" style={{ padding: 12 }}>
          {!code ? (
            <form class="name-row" style={{ padding: 0 }} onSubmit={create}>
              <input aria-label="Device name" placeholder="Office PC" required value={name} onInput={(e) => setName(e.currentTarget.value)} />
              <button class="btn primary">Create code</button><button type="button" class="btn" onClick={() => setAdding(false)}>Cancel</button>
            </form>
          ) : (
            <div class="section">
              <div><span class="hint" style={{ margin: 0 }}>One-time code, valid 15 minutes</span><div class="big num" style={{ letterSpacing: '0.12em' }}>{code}</div></div>
              <span class="hint" style={{ margin: 0 }}>Send this to the other computer (or read it from there):</span>
              <div class="cmd"><code style={{ whiteSpace: 'pre', fontSize: 11 }}>{invite}</code><button class="btn" onClick={() => copy(invite)}>{copied === invite ? 'Copied' : 'Copy'}</button></div>
              <span class="hint" style={{ margin: 0 }}>Or, without the app, connect it from a terminal:</span>
              {cmds.map(([l, c]) => (
                <div key={l} class="cmd"><span class="hint" style={{ margin: 0, width: 92 }}>{l}</span><code>{c}</code><button class="btn" onClick={() => copy(c)}>{copied === c ? 'Copied' : 'Copy'}</button></div>
              ))}
              <div class="actions"><button class="btn" onClick={() => { setAdding(false); q.reload() }}>Done</button></div>
            </div>
          )}
          {err && <p class="err">{err}</p>}
        </div>
      )}
      <Load q={q}>
        {(list) => (
          <table class="list">
            <thead><tr><th>Device</th><th>System</th><th>Status</th><th class="r">30 days</th><th /></tr></thead>
            <tbody>
              {list.map((d, i) => (<Fragment key={d.id}>
                <tr key={d.id} style={d.revoked_at ? { opacity: 0.5 } : undefined} class={d.revoked_at ? '' : 'has-details'}>
                  <td><span class="name"><Chip i={i} /> {d.name}</span></td>
                  <td class="hint" style={{ margin: 0 }}>{d.os ? `${OS[d.os] ?? d.os} · ${d.agent_version ?? ''}` : 'Waiting for first sync'}</td>
                  <td>{d.revoked_at ? 'Disconnected' : <Health ts={d.last_seen} appAt={d.health?.app_at} />}
                    {!d.revoked_at && d.disconnect_requested_at && <div class="request">Asks to be disconnected · {ago(d.disconnect_requested_at)}
                      <span><button class="btn primary" onClick={revoke(d)}>Approve</button> <button class="btn" onClick={() => decline(d)}>Decline</button></span></div>}</td>
                  <td class="r num">{fmt(usage.data?.by.device.find((x) => x.key === d.id)?.tokens ?? 0)}</td>
                  <td class="r">{!d.revoked_at && (edit?.id === d.id ? (
                    edit.mode === 'rename' ? (
                      <form class="inline-confirm" onSubmit={rename(d, edit.name)}>
                        <input aria-label="New name" value={edit.name} onInput={(e) => setEdit({ ...edit, name: e.currentTarget.value })} />
                        <button class="btn primary" disabled={!edit.name.trim()}>Save</button><button type="button" class="btn" onClick={() => setEdit(null)}>Cancel</button>
                      </form>
                    ) : (
                      <span class="inline-confirm"><span>Stop tracking it now? Past usage stays.</span>
                        <button class="btn danger" onClick={revoke(d)}>Disconnect</button><button class="btn" onClick={() => setEdit(null)}>Cancel</button></span>
                    )
                  ) : <><button class="link-btn" onClick={() => setEdit({ id: d.id, mode: 'rename', name: d.name })}>Rename</button><button class="link-btn" onClick={() => setEdit({ id: d.id, mode: 'disconnect', name: d.name })}>Disconnect</button></>)}</td>
                </tr>
                {!d.revoked_at && <tr class="details-row"><td colSpan={5}><DeviceDetails d={d} settings={settings.data ?? []} saved={settings.reload} /></td></tr>}
              </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </Load>
      <AccountsSection />
    </div>
  )
}

// ---------- People (admin) ----------
// One owner, several computers: a "person" is a Claude account. Waiting accounts come first.
type Person = { uuid: string; email: string | null; display_name: string | null; plan: string | null; status: 'approved' | 'ignored' | 'pending'; today: number; week: number; month: number; last_active: number | null; devices: { id: string; name: string }[] }

// Shown under Devices: most people use one account, so it doesn't need its own tab.
function AccountsSection() {
  const q = useLoad<Person[]>('/people')
  const set = async (uuid: string, status: string) => { await api(`/accounts/${uuid}`, 'PATCH', { status }); q.reload() }
  return (
    <section class="section"><h2>Claude accounts</h2>
      <Load q={q}>
        {(list) => !list.length ? <p class="hint">No accounts yet. They appear after a computer's first sync.</p> : (
          <>
            {list.some((p) => p.status === 'pending') && <p class="hint" style={{ marginTop: 0 }}>New accounts are not tracked until you choose <b>Track</b>.</p>}
            <table class="list">
              <thead><tr><th>Account</th><th class="r">Today</th><th class="r">7 days</th><th class="r">30 days</th><th>Last active</th><th /></tr></thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.uuid} style={p.status === 'ignored' ? { opacity: 0.5 } : undefined}>
                    <td>{p.email ?? p.display_name ?? p.uuid}<div class="hint" style={{ margin: 0 }}>{p.devices.length ? p.devices.map((d) => d.name).join(', ') : p.status === 'pending' ? 'Waiting for you' : p.status === 'ignored' ? 'Ignored' : 'No recent use'}</div></td>
                    <td class="r num">{fmt(p.today)}</td><td class="r num">{fmt(p.week)}</td><td class="r num">{fmt(p.month)}</td>
                    <td>{ago(p.last_active)}</td>
                    <td class="r">
                      {p.status !== 'approved' && <button class="btn primary" onClick={() => set(p.uuid, 'approved')}>Track</button>}
                      {p.status === 'approved' && <button class="link-btn" onClick={() => set(p.uuid, 'ignored')}>Stop tracking</button>}
                      {p.status === 'pending' && <button class="link-btn" onClick={() => set(p.uuid, 'ignored')}>Ignore</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Load>
    </section>
  )
}

// ---------- Prompts (admin, reached from Settings only) ----------
type PromptRow = { id: string; ts: number; text: string | null; project_key: string; device_id: string; session_id: string; title: string | null }

const dayLabel = (ts: number) => {
  const d = new Date(ts), now = new Date()
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString()
  const full = d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  if (same(d, now)) return `Today · ${full}`
  if (same(d, new Date(now.getTime() - 86400_000))) return `Yesterday · ${full}`
  return full
}
// On each prompt: "Thu, 1 Oct · 6:44 PM" (with the year when it isn't this year).
const promptWhen = (ts: number) => {
  const d = new Date(ts)
  const date = d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) })
  return `${date} · ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
}

function Highlight({ text }: { text: string }) {
  return <>{text.split('\u0002').map((part, i) => {
    if (!i) return part
    const [hit, rest = ''] = part.split('\u0003')
    return <><mark>{hit}</mark>{rest}</>
  })}</>
}

// Admin only, reached from Settings: prompts by device and day, newest first.
const PROMPT_RANGES = [['1', 'Today'], ['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['365', 'Year'], ['custom', 'Dates']] as const

function PromptsView({ back }: { back: () => void }) {
  // Prompts opened in full (the list has the first 400 characters).
  const [full, setFull] = useState<Record<string, string>>({})
  const [text, setText] = useState('')
  const [q2, setQ2] = useState('')
  const [device, setDevice] = useState('')
  const [project, setProject] = useState('')
  const [range, setRange] = useState<(typeof PROMPT_RANGES)[number][0]>('30')
  const [dates, setDates] = useState({ from: '', to: '' })
  useEffect(() => { const t = setTimeout(() => setQ2(text.trim()), 300); return () => clearTimeout(t) }, [text])
  const usage = useLoad<DeviceUsage[]>('/device-usage')
  const labels = useLoad<Overview>('/overview?days=365')
  const settings = useLoad<SettingRow[]>('/settings')
  // A device's allowed projects (Devices → Projects); prompts elsewhere are flagged.
  const allowedOn = (id: string) => (JSON.parse(settings.data?.find((r) => r.scope === 'device' && r.scope_id === id)?.json ?? '{}').allowed_projects ?? []) as string[]
  // Device names come from the overview (every server version); last-prompt times when the server has them.
  const devices = (labels.data?.labels.devices ?? []).map((d, chip) => ({ ...d, chip, last_prompt: usage.data?.find((u) => u.id === d.id)?.last_prompt ?? null }))
  const projects = (labels.data?.labels.projects ?? []).slice().sort((a, b) => (a.display_name ?? a.key).localeCompare(b.display_name ?? b.key))
  const projectName = (key: string) => projects.find((p) => p.key === key)?.display_name ?? key.split('/').pop() ?? key
  const dev = (id: string) => devices.find((d) => d.id === id)
  const when_ = range === 'custom' ? `${dates.from ? `&from=${dates.from}` : ''}${dates.to ? `&to=${dates.to}` : ''}${!dates.from ? '&days=3650' : ''}` : `&days=${range}`
  const base = `/prompts?${when_.slice(1)}${device ? `&device=${device}` : ''}${project ? `&project=${encodeURIComponent(project)}` : ''}${q2 ? `&q=${encodeURIComponent(q2)}` : ''}`
  // Newest 50 first; "Load more" asks for the 50 before the oldest shown.
  const [rows, setRows] = useState<PromptRow[]>([])
  const [state, setState] = useState<{ loading: boolean; more: boolean; error: string }>({ loading: true, more: false, error: '' })
  const load = (before?: number) => {
    setState((s) => ({ ...s, loading: true, error: '' }))
    api<PromptRow[]>(`${base}${before ? `&before=${before}` : ''}`).then((r) => {
      setRows((old) => (before ? [...old, ...r] : r))
      setState({ loading: false, more: r.length >= 50, error: '' })
    }, (e) => setState({ loading: false, more: false, error: String(e) }))
  }
  useEffect(() => { setRows([]); load() }, [base])
  const groups: [string, PromptRow[]][] = []
  for (const p of rows) {
    const label = dayLabel(p.ts)
    if (groups.at(-1)?.[0] !== label) groups.push([label, []])
    groups.at(-1)![1].push(p)
  }
  const filtered = !!(device || project || q2 || range !== '30')
  return (
    <div class="page">
      <div class="toolbar"><button class="btn" onClick={back}>‹ Settings</button>
        <input type="search" placeholder="Search prompt text" aria-label="Search prompts" value={text} onInput={(e) => setText(e.currentTarget.value)} style={{ flex: 1 }} /></div>
      <div class="prompt-filters">
        <Seg label="When" value={range} options={PROMPT_RANGES} onChange={setRange} />
        {range === 'custom' && <span class="dates">
          <input type="date" aria-label="From" value={dates.from} onInput={(e) => setDates({ ...dates, from: e.currentTarget.value })} /> to
          <input type="date" aria-label="To" value={dates.to} onInput={(e) => setDates({ ...dates, to: e.currentTarget.value })} />
        </span>}
        <select aria-label="Project" value={project} onChange={(e) => setProject(e.currentTarget.value)}>
          <option value="">All projects</option>
          {projects.map((p) => <option key={p.key} value={p.key}>{p.display_name ?? p.key}</option>)}
        </select>
        {filtered && <button class="link-btn" onClick={() => { setDevice(''); setProject(''); setText(''); setRange('30') }}>Clear filters</button>}
      </div>
      <div class="chips" role="group" aria-label="Device">
        <button class="chip-btn" aria-pressed={!device} onClick={() => setDevice('')}>All devices</button>
        {devices.map((d) => (
          <button key={d.id} class="chip-btn" aria-pressed={device === d.id} onClick={() => setDevice(d.id)}>
            <Chip i={d.chip} /> {d.name}{usage.data && <span class="hint" style={{ margin: 0 }}> · last prompt {ago(d.last_prompt)}</span>}
          </button>
        ))}
      </div>
      {state.error && <p class="err" role="alert">{state.error}</p>}
      {!state.loading && !rows.length && !state.error && <p class="hint">No prompts found{device ? ' on this device' : ''}{project ? ` in ${projectName(project)}` : ''}{q2 ? ` for "${q2}"` : ''} in this time range.</p>}
      {groups.map(([label, list]) => (
        <section key={label} class="section">
          <h2 class="sticky-day">{label}</h2>
          <ol class="prompts">
            {list.map((p) => {
              const d = dev(p.device_id)
              const allowed = allowedOn(p.device_id)
              const outside = allowed.length > 0 && !allowed.includes(p.project_key)
              // Notes the editor adds by itself (e.g. which file is open), not typed by anyone.
              const notice = /^\s*<ide_/.test(p.text ?? '')
              return (
                <li key={p.id} class={`${outside ? 'outside' : ''} ${notice ? 'notice' : ''}`}>
                  <span class="prompt-meta num">
                    <b title={new Date(p.ts).toLocaleString()}>{promptWhen(p.ts)}</b>
                    {d && <button class="meta-pill" title="Show only this device" onClick={() => setDevice(d.id)}><Chip i={d.chip} /> {d.name}</button>}
                    <button class="meta-pill" title={`Project: ${p.project_key} (show only this project)`} onClick={() => setProject(p.project_key)}>📁 {projectName(p.project_key)}</button>
                    <span class="meta-pill static" title="Coding agent"><Mark of="claude" />Claude Code</span>
                    {outside && <span class="badge bad" title="Not in this computer's allowed projects (Devices)">Outside its projects</span>}
                    {notice && <span class="badge" title="Added automatically by the editor, not typed">Editor notice</span>}
                    {p.title && <span class="hint" style={{ margin: 0 }} title="Session">{p.title}</span>}
                  </span>
                  {/* Without a search the list shows the first 400 characters of each prompt. */}
                  {full[p.id] != null ? <div>{full[p.id]} <button class="link-btn" onClick={() => setFull(({ [p.id]: _, ...rest }) => rest)}>Show less</button></div>
                    : <div><Highlight text={p.text ?? ''} />{!q2 && (p.text?.length ?? 0) >= 400 && <>… <button class="link-btn" onClick={() => api<{ text: string }>(`/prompts/${encodeURIComponent(p.id)}`).then((r) => setFull((f) => ({ ...f, [p.id]: r.text })), () => {})}>Show full prompt</button></>}</div>}
                </li>
              )
            })}
          </ol>
        </section>
      ))}
      <div class="actions" style={{ justifyContent: 'center' }}>
        {state.loading ? <span class="hint">Loading…</span>
          : state.more ? <button class="btn" onClick={() => load(rows.at(-1)!.ts)}>Load more</button>
          : rows.length ? <span class="hint">{rows.length} prompt{rows.length > 1 ? 's' : ''} · that's all in this range</span> : null}
      </div>
    </div>
  )
}

// ---------- Settings ----------
const TOGGLES = [
  ['tracking', 'Tracking', 'Pause everything when off.'],
  ['prompt_text', 'Collect prompt text', 'Off sends that a prompt happened, without its words.'],
  ['redact_secrets', 'Redact secrets', 'Keys, tokens and passwords are removed before upload.'],
  ['subagents', 'Subagent usage', ''],
  ['auto_update', 'Automatic agent updates', ''],
] as const

function ConnectionGroup({ st, refresh }: { st: Status; refresh: () => void }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [conn, setConn] = useState({ server: '', code: '' })
  const [mode, setMode] = useState<'none' | 'signin' | 'create'>('none')
  const [f, setF] = useState({ server: '', email: '', password: '', token: '' })
  const [autostart, setAutostart] = useState(false)
  const [name, setName] = useState(navigator.userAgent.includes('Mac') ? 'My Mac' : navigator.userAgent.includes('Windows') ? 'My PC' : 'My computer')
  const [saved, setSaved] = useState<string[]>([])
  useEffect(() => {
    isEnabled().then(setAutostart, () => {})
    invoke<{ saved: string[] } | null>('servers').then((r) => setSaved(r?.saved ?? []))
  }, [st.server])
  const run = (fn: () => Promise<unknown>) => async (e?: Event) => {
    e?.preventDefault(); setBusy(true); setErr('')
    try { await fn(); setMode('none'); refresh() } catch (x) { setErr(String(x)) } finally { setBusy(false) }
  }
  const server = f.server || st.agent_server
  return (
    <section class="section">
      <h2>Connection</h2>
      <div class="group">
        <div class="field"><span>This computer</span><span class="val">{st.this_device_connected ? `Connected to ${st.agent_server.replace(/^https?:\/\//, '')}` : 'Not connected'}</span></div>
        {!st.this_device_connected && !st.signed_in && (
          <form onSubmit={run(() => invoke('connect_with_code', conn))}>
            <div class="field"><label for="cs">Server</label><input id="cs" type="url" placeholder="Paste the server address" required value={conn.server} onInput={(e) => setConn({ ...conn, server: e.currentTarget.value })} /></div>
            <div class="field"><label for="cc">Code</label><input id="cc" type="text" placeholder="6 letters" required maxLength={6} value={conn.code} onInput={(e) => setConn({ ...conn, code: e.currentTarget.value })} /></div>
            {/* Disclosure, shown once when connecting (owner's prompt collection is their choice; people are told). */}
            <p class="hint">Usage from this computer, including prompt text if the admin collects it, is sent to this server's admin.</p>
            <div class="name-row" style={{ justifyContent: 'flex-end' }}><button class="btn primary" disabled={busy}>{busy ? 'Connecting…' : 'Connect'}</button></div>
          </form>
        )}
        {!st.this_device_connected && st.signed_in && (
          <div class="name-row">
            <input aria-label="Name for this computer" value={name} onInput={(e) => setName(e.currentTarget.value)} />
            <button class="btn primary" disabled={busy || !name.trim()} onClick={run(() => invoke('add_this_device', { name }))}>{busy ? 'Connecting…' : 'Add this computer'}</button>
          </div>
        )}
        <div class="field"><label for="a">Open at login</label>
          <input id="a" type="checkbox" checked={autostart} onChange={async (e) => { const on = e.currentTarget.checked; await (on ? enable() : disable()); setAutostart(on) }} /></div>
        {st.signed_in && mode === 'none' ? (
          <div class="field">
            {saved.length > 1 ? (
              <label>Admin of <select aria-label="Server" value={st.server} onChange={(e) => run(() => invoke('switch_server', { server: e.currentTarget.value }))()}>
                {saved.map((x) => <option key={x} value={x}>{x.replace(/^https?:\/\//, '')}</option>)}
              </select></label>
            ) : <span>Admin · {st.server.replace(/^https?:\/\//, '')}</span>}
            <span><button class="btn" onClick={() => setMode('signin')}>Add server</button> <button class="btn" disabled={busy} onClick={run(() => invoke('sign_out'))}>Sign out</button></span>
          </div>
        ) : mode === 'none' ? (
          <div class="field"><span class="val">Admin</span><span><button class="btn" onClick={() => setMode('signin')}>Sign in</button> <button class="btn" onClick={() => setMode('create')}>New server</button></span></div>
        ) : (
          <form onSubmit={run(() => mode === 'signin' ? invoke('sign_in', { server, email: f.email, password: f.password })
            : invoke('create_admin', { server, token: f.token, email: f.email, password: f.password, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }))}>
            <div class="field"><label for="s">Server</label><input id="s" type="url" required placeholder="Paste the server address" value={server} onInput={(e) => setF({ ...f, server: e.currentTarget.value })} /></div>
            {mode === 'create' && <div class="field"><label for="t">Setup token</label><input id="t" type="password" required value={f.token} onInput={(e) => setF({ ...f, token: e.currentTarget.value })} /></div>}
            <div class="field"><label for="e">Email</label><input id="e" type="email" required value={f.email} onInput={(e) => setF({ ...f, email: e.currentTarget.value })} /></div>
            <div class="field"><label for="p">Password</label><input id="p" type="password" required minLength={mode === 'create' ? 10 : 1} value={f.password} onInput={(e) => setF({ ...f, password: e.currentTarget.value })} /></div>
            <div class="name-row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" class="btn" onClick={() => setMode('none')}>Cancel</button>
              <button class="btn primary" disabled={busy}>{busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create admin login'}</button>
            </div>
          </form>
        )}
      </div>
      {err && <p class="err" role="alert">{err}</p>}
    </section>
  )
}

type SettingRow = { scope: string; scope_id: string; json: string }
type ToolInfo = { tool: string; label: string; enabled: boolean; devices: unknown[] }

// Admin, on a connected computer: put tracking where only an administrator can change it.
function LockGroup() {
  const [st, setSt] = useState<{ locked: boolean; outdated: boolean; supported: boolean } | null>(null)
  const [opts, setOpts] = useState({ only_ours: false, block_skip: true })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const load = () => invoke<typeof st>('lock_status').then(setSt, () => {})
  useEffect(() => { load() }, [])
  if (!st) return null
  const run = (cmd: string, args: Record<string, unknown> = {}) => async () => {
    setBusy(true); setMsg('')
    try { await invoke(cmd, args); setMsg(cmd === 'lock_computer' ? 'Locked.' : 'Unlocked.') } catch (x) { setMsg(String(x)) } finally { setBusy(false); load() }
  }
  return (
    <section class="section"><h2>Lock this computer</h2>
      <div class="group">
        <div class="field"><span>{st.locked ? '🔒 Locked' : 'Not locked'}<div class="hint" style={{ margin: 0 }}>
          {st.locked ? 'Claude Code always runs DeviceTally\'s hooks here, in every settings folder, terminal and editor. Changing that needs this Mac\'s admin password.'
            : 'Puts DeviceTally\'s hooks in Claude Code\'s system-wide settings, so tracking can\'t be turned off or bypassed with another settings folder without this Mac\'s admin password.'}</div></span>
          {st.supported && (st.locked
            ? <span>{st.outdated && <button class="btn primary" disabled={busy} onClick={run('lock_computer', opts)}>Update lock</button>} <button class="btn" disabled={busy} onClick={run('unlock_computer')}>Unlock</button></span>
            : <button class="btn primary" disabled={busy} onClick={run('lock_computer', opts)}>{busy ? 'Waiting for the password…' : 'Lock'}</button>)}
        </div>
        {st.outdated && <div class="field"><span class="warn">The locked tracker is older than this app. Update the lock to use the new one.</span></div>}
        {!st.locked && st.supported && <>
          <div class="field"><label for="lk1">Block "skip permissions" mode<div class="hint" style={{ margin: 0 }}>Claude Code won't start with --dangerously-skip-permissions.</div></label>
            <input id="lk1" type="checkbox" checked={opts.block_skip} onChange={(e) => setOpts({ ...opts, block_skip: e.currentTarget.checked })} /></div>
          <div class="field"><label for="lk2">Only DeviceTally's hooks<div class="hint" style={{ margin: 0 }}>Hooks the person adds themselves won't run.</div></label>
            <input id="lk2" type="checkbox" checked={opts.only_ours} onChange={(e) => setOpts({ ...opts, only_ours: e.currentTarget.checked })} /></div>
        </>}
        {!st.supported && <div class="field"><span class="hint" style={{ margin: 0 }}>Available on macOS for now.</span></div>}
      </div>
      <p class="hint">Works fully when the person uses a standard (not administrator) Mac account and doesn't know the admin password. macOS asks for an administrator's password.</p>
      {msg && <p class="hint" role="status">{msg}</p>}
    </section>
  )
}

function AdminSettings({ openPrompts }: { openPrompts: () => void }) {
  const rows = useLoad<SettingRow[]>('/settings')
  const tools = useLoad<ToolInfo[]>('/tools')
  const me = useLoad<{ timezone: string }>('/auth/me')
  const devices = useLoad<Device[]>('/devices')
  const [msg, setMsg] = useState('')
  const global = JSON.parse(rows.data?.find((r) => r.scope === 'global')?.json ?? '{}')
  const save = async (patch: object) => {
    try { await api('/settings/global', 'PUT', { ...global, ...patch }); rows.reload(); tools.reload(); setMsg('Saved') } catch (x) { setMsg(String(x)) }
  }
  const [del, setDel] = useState({ scope: 'device', id: '', from: '', to: '' })
  const [delConfirm, setDelConfirm] = useState<string | null>(null)
  const doDelete = async () => {
    try { const r = await api<{ deleted: boolean }>('/data/delete', 'POST', del); setMsg(r.deleted ? 'Deleted.' : 'Nothing matched.'); setDelConfirm(null) } catch (x) { setMsg(String(x)) }
  }
  const zones = (Intl as any).supportedValuesOf?.('timeZone') as string[] | undefined
  return (
    <>
      <section class="section"><h2>Tracking (all devices)</h2>
        <div class="group">
          {TOGGLES.map(([k, l, h]) => (
            <div class="field" key={k}><label for={`g-${k}`}>{l}{h && <div class="hint" style={{ margin: 0 }}>{h}</div>}</label>
              <input id={`g-${k}`} type="checkbox" checked={global[k] ?? true} onChange={(e) => save({ [k]: e.currentTarget.checked })} /></div>
          ))}
          <div class="field"><label for="g-upd">Updates on joined computers<div class="hint" style={{ margin: 0 }}>Ask: a "new version" card with Update now / Later. Automatic: installs when DeviceTally isn't in use, then says so. Each device can override it (Devices).</div></label>
            <select id="g-upd" value={global.app_updates === 'ask' ? 'ask' : 'auto'} onChange={(e) => save({ app_updates: e.currentTarget.value })}><option value="auto">Automatic</option><option value="ask">Ask the user</option></select></div>
          <div class="field"><label for="keep">Keep prompt text for</label>
            <select id="keep" value={String(global.keep_prompts_days === null ? 'forever' : global.keep_prompts_days ?? 90)} onChange={(e) => save({ keep_prompts_days: e.currentTarget.value === 'forever' ? null : Number(e.currentTarget.value) })}>
              {[30, 90, 180, 365].map((d) => <option key={d} value={d}>{d} days</option>)}<option value="forever">Forever</option>
            </select></div>
        </div>
      </section>
      <section class="section"><h2>Other AI tools</h2>
        <div class="group">
          {(tools.data ?? []).map((t) => (
            <div class="field" key={t.tool}><label for={`t-${t.tool}`}>{t.label}<div class="hint" style={{ margin: 0 }}>{t.devices.length ? `Found on ${t.devices.length} device${t.devices.length > 1 ? 's' : ''}` : 'Not found yet'}</div></label>
              <input id={`t-${t.tool}`} type="checkbox" checked={t.enabled} onChange={(e) => save({ tools: { ...(global.tools ?? {}), [t.tool]: e.currentTarget.checked } })} /></div>
          ))}
        </div>
      </section>
      <section class="section"><h2>Data</h2>
        <div class="group">
          <div class="field"><label for="tz">Time zone</label>
            <select id="tz" value={me.data?.timezone} onChange={async (e) => { await api('/owner/timezone', 'PUT', { timezone: e.currentTarget.value }); me.reload(); setMsg('Saved') }}>
              {[...new Set([me.data?.timezone ?? 'UTC', ...(zones ?? [])])].map((z) => <option key={z} value={z}>{z}</option>)}
            </select></div>
          <div class="field"><span>Export</span><span>
            <button class="btn" onClick={async () => setMsg(`Saved to ${await invoke<string>('save_export', { format: 'json' })}`)}>JSON</button>{' '}
            <button class="btn" onClick={async () => setMsg(`Saved to ${await invoke<string>('save_export', { format: 'csv' })}`)}>Daily CSV</button></span></div>
          <div class="field"><span>Delete</span><span style={{ display: 'flex', gap: 6 }}>
            <select aria-label="Delete what" value={del.scope} onChange={(e) => setDel({ ...del, scope: e.currentTarget.value })}><option value="device">Device</option><option value="range">Dates</option></select>
            {del.scope === 'device' ? (
              <select aria-label="Device" value={del.id} onChange={(e) => setDel({ ...del, id: e.currentTarget.value })}>
                <option value="">Choose…</option>{(devices.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            ) : (
              <><input type="date" aria-label="From" value={del.from} onInput={(e) => setDel({ ...del, from: e.currentTarget.value })} /><input type="date" aria-label="To" value={del.to} onInput={(e) => setDel({ ...del, to: e.currentTarget.value })} /></>
            )}
            <button class="btn" disabled={del.scope === 'device' ? !del.id : !(del.from && del.to)} onClick={() => setDelConfirm('')}>Delete</button></span></div>
          {delConfirm !== null && <div class="field"><span>This permanently deletes the selected data. Type DELETE to confirm.</span><span class="inline-confirm">
            <input aria-label="Type DELETE" value={delConfirm} onInput={(e) => setDelConfirm(e.currentTarget.value)} />
            <button class="btn danger" disabled={delConfirm !== 'DELETE'} onClick={doDelete}>Delete</button><button class="btn" onClick={() => setDelConfirm(null)}>Cancel</button></span></div>}
          <div class="field"><span>Prompts</span><button class="btn" onClick={openPrompts}>View prompts</button></div>
          <div class="field"><span>Sign out on every computer</span><button class="btn" onClick={async () => { await api('/auth/logout-everywhere', 'POST', {}); location.reload() }}>Sign out everywhere</button></div>
        </div>
      </section>
      <DeleteEverything />
      {msg && <p class="hint" role="status">{msg}</p>}
    </>
  )
}

/** Admin, stopping DeviceTally: delete the server and database in Cloudflare and the tracking here. */
function DeleteEverything() {
  const meta = useLoad<{ host?: string }>('/meta')
  const [open, setOpen] = useState(false)
  const [token, setToken] = useState('')
  const [confirmText, setConfirm] = useState('')
  const [log, setLog] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => {
    const un = listen<string>('setup-progress', (e) => setLog((l) => [...l, e.payload]))
    return () => { un.then((f) => f()) }
  }, [])
  const go = async (e: Event) => {
    e.preventDefault(); setBusy(true); setErr(''); setLog([])
    try { await invoke('delete_server', { cfToken: token }); location.reload() } catch (x) { setErr(String(x)) } finally { setBusy(false) }
  }
  if (meta.data?.host === 'node') return (
    <section class="section"><h2>Stop using DeviceTally</h2>
      <p class="hint">Your server runs on your own machine. Export your data first if you want a copy, then stop it and delete its data there: <code>docker compose down -v</code></p>
    </section>
  )
  return (
    <section class="section"><h2>Stop using DeviceTally</h2>
      <div class="group">
        {!open ? (
          <div class="field"><span>Delete your server, its database and all usage in Cloudflare, and remove tracking from this computer.</span><button class="btn danger" onClick={() => setOpen(true)}>Delete DeviceTally</button></div>
        ) : (
          <form onSubmit={go} style={{ padding: '8px 0' }}>
            <p style={{ marginTop: 0 }}>This can't be undone. Export your data first if you want a copy. Other computers stop syncing; remove the app from them by dragging it to the Bin.</p>
            <ol class="ob-list">
              <li>Open Cloudflare's token page, signed in to the account where DeviceTally runs.<OpenLink url={TOKEN_URL} label="Open Cloudflare's token page" /></li>
              <li>Click <b>Continue to summary</b>, <b>Create Token</b>, then <b>Copy</b> and paste it here. It's used once and not stored.</li>
            </ol>
            <input class="ob-input" type="password" aria-label="Cloudflare token" placeholder="Paste the token" required value={token} onInput={(e) => setToken(e.currentTarget.value)} disabled={busy} />
            <input class="ob-input" aria-label="Type DELETE to confirm" placeholder="Type DELETE to confirm" value={confirmText} onInput={(e) => setConfirm(e.currentTarget.value)} disabled={busy} />
            {busy && <ul class="ob-progress" aria-live="polite">{log.map((l, i) => <li key={i}>{i < log.length - 1 ? '✓' : '…'} {l}</li>)}</ul>}
            {err && <p class="err" role="alert">{err}</p>}
            <div class="actions"><button type="button" class="btn" onClick={() => setOpen(false)} disabled={busy}>Cancel</button><button class="btn danger" disabled={busy || !token.trim() || confirmText !== 'DELETE'}>{busy ? 'Deleting…' : 'Delete everything'}</button></div>
            <p class="hint">Afterwards, drag DeviceTally from Applications to the Bin to remove the app itself.</p>
          </form>
        )}
      </div>
    </section>
  )
}

function DeviceSettings({ st, refresh }: { st: Status; refresh: () => void }) {
  const [autostart, setAutostart] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => { isEnabled().then(setAutostart, () => {}) }, [])
  // The admin decides: this computer can only ask. Once approved, it can remove DeviceTally here.
  const [req, setReq] = useState<{ requested_at: number | null } | 'approved'>({ requested_at: null })
  const [confirmRemove, setConfirmRemove] = useState(false)
  const loadReq = () => api<{ requested_at: number | null }>('/disconnect-request').then(setReq, (e) => { if (String(e) === 'signed_out') setReq('approved'); else setErr(`Couldn't check the request: ${e}`) })
  useEffect(() => { loadReq() }, [])
  const run = (fn: () => Promise<unknown>) => async () => {
    setBusy(true); setErr('')
    try { await fn(); await loadReq() } catch (x) { setErr(String(x)) } finally { setBusy(false) }
  }
  const remove = run(async () => { await invoke('disconnect_this_computer'); refresh() })
  return (
    <section class="section"><h2>This computer</h2>
      <div class="group">
        <div class="field"><span>Connected to</span><span class="val">{st.agent_server.replace(/^https?:\/\//, '')}</span></div>
        <div class="field"><label for="a">Open at login<div class="hint" style={{ margin: 0 }}>Required while this computer is connected. Ask your DeviceTally admin.</div></label>
          <input id="a" type="checkbox" checked={autostart} disabled title="Required while this computer is connected" /></div>
        {req === 'approved' ? (
          <div class="field"><span>The admin disconnected this computer.<div class="hint" style={{ margin: 0 }}>Removing tracking deletes DeviceTally's hooks here. Usage already sent stays on the server.</div></span>
            {confirmRemove ? <span class="inline-confirm"><button class="btn danger" disabled={busy} onClick={remove}>Remove</button><button class="btn" onClick={() => setConfirmRemove(false)}>Cancel</button></span>
              : <button class="btn" onClick={() => setConfirmRemove(true)}>Remove tracking…</button>}</div>
        ) : req.requested_at ? (
          <div class="field"><span>✓ Request sent {ago(req.requested_at)}.<div class="hint" style={{ margin: 0 }}>The admin sees it under Devices. This computer keeps tracking until they approve.</div></span><button class="btn" disabled={busy} onClick={run(() => api('/disconnect-request', 'DELETE'))}>Cancel request</button></div>
        ) : (
          <div class="field"><span>Stop tracking<div class="hint" style={{ margin: 0 }}>The admin approves this from their Devices list.</div></span><button class="btn" disabled={busy} onClick={run(() => api('/disconnect-request', 'POST', {}))}>Ask the admin to disconnect</button></div>
        )}
      </div>
      {err && <p class="err" role="alert">{err}</p>}
    </section>
  )
}

// Admin: keep the server on the same version as this app (servers created by the app have no
// checked-out code for `npm run update`). Needs a Cloudflare token again; it isn't stored.
const newer = (a: string, b: string) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false }

/** Paste a Cloudflare token, update the server, show progress. Used in Settings and in the banner. */
function UpdateServerForm({ close, done }: { close: () => void; done: () => void }) {
  const [token, setToken] = useState('')
  const [log, setLog] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => {
    const un = listen<string>('setup-progress', (e) => setLog((l) => [...l, e.payload]))
    return () => { un.then((f) => f()) }
  }, [])
  const update = async (e: Event) => {
    e.preventDefault(); setBusy(true); setLog([]); setErr('')
    try { await invoke('update_server', { cfToken: token }); setToken(''); done() } catch (x) { setErr(String(x)) } finally { setBusy(false) }
  }
  return (
    <form onSubmit={update} style={{ padding: '8px 0' }}>
      <ol class="ob-list">
        <li>Open Cloudflare's token page, signed in to the account where DeviceTally runs.<OpenLink url={TOKEN_URL} label="Open Cloudflare's token page" /></li>
        <li>Click <b>Continue to summary</b>, <b>Create Token</b>, then <b>Copy</b> and paste it here. It's used once and not stored.</li>
      </ol>
      <input class="ob-input" type="password" aria-label="Cloudflare token" placeholder="Paste the token" required value={token} onInput={(e) => setToken(e.currentTarget.value)} disabled={busy} />
      {busy && <ul class="ob-progress" aria-live="polite">{log.map((l, i) => <li key={i}>{i < log.length - 1 ? '✓' : '…'} {l}</li>)}</ul>}
      {err && <p class="err" role="alert">{err}</p>}
      <div class="actions" style={{ marginTop: 8 }}><button type="button" class="btn" onClick={close} disabled={busy}>Cancel</button><button class="btn primary" disabled={busy || !token.trim()}>{busy ? 'Updating…' : 'Update server'}</button></div>
    </form>
  )
}

/** How to update a server that runs outside Cloudflare (Docker / Node): the app can't do it from here. */
const SELF_HOSTED_UPDATE = 'In the folder you run it from: git pull && docker compose up -d --build'

function ServerGroup() {
  const meta = useLoad<{ version: string; host?: string }>('/meta')
  const [bundled, setBundled] = useState('')
  const [open, setOpen] = useState(false)
  const [msg, setMsg] = useState('')
  useEffect(() => { invoke<string>('bundled_server_version').then(setBundled) }, [])
  // A server too old to answer /meta is outdated too.
  const outdated = !!bundled && (meta.error ? true : !!meta.data && newer(bundled, meta.data.version))
  return (
    <section class="section"><h2>Server</h2>
      <div class="group">
        <div class="field"><span>Server version</span><span class="val">{meta.data?.version ?? (meta.error ? 'older version' : '…')}{outdated ? ` · ${bundled} available` : meta.data ? ' · up to date' : ''}</span></div>
        {meta.data?.host === 'node' ? <div class="field"><span>{outdated ? `Update to ${bundled}` : 'Update'}</span><span class="val">{SELF_HOSTED_UPDATE}</span></div>
        : !open && <div class="field"><span>{outdated ? `Update to ${bundled}` : 'Reinstall the server code'}</span><button class={outdated ? 'btn primary' : 'btn'} onClick={() => { setOpen(true); setMsg('') }}>Update server</button></div>}
        {open && <UpdateServerForm close={() => setOpen(false)} done={() => { setOpen(false); setMsg('Server updated.'); meta.reload(); window.dispatchEvent(new Event('dt:server-updated')) }} />}
      </div>
      {msg && <p class="hint" role="status">{msg}</p>}
    </section>
  )
}

// ---------- Menu bar (every computer: it's this computer's menu bar) ----------
type ItemStyle = { label: '' | 'text' | 'icon' | 'inside' | 'none'; color: string; label_color: string; scale: number; layout: '' | 'row' | 'stacked' | 'top' }
const CLOCK_SPACING = ['tight', 'thin', '', 'wide']
type ClockCfg = { hour12: boolean; ampm: boolean; weekday: boolean; day: boolean; month: boolean; spacing: string }
type MenuBarCfg = { items: string[]; layout: 'row' | 'stacked' | 'top'; size: string; spacing: string; labels: boolean; net_stack: boolean; scale: number; gap: number
  gap_pt: number | null; weight: 'regular' | 'medium' | 'bold'; font: string; label_color: string; value_color: string
  styles: Record<string, ItemStyle>; clock: ClockCfg; max_width: number; status_dot: boolean; combined: boolean; ring_color: boolean; agent_motion: string; agent_done: string
  alerts: { done_banner: boolean; done_sound: string; done_sound_on: boolean; wait_banner: boolean; wait_sound: string; wait_sound_on: boolean; min_seconds: number; disk_alert: boolean } }
/** One alert event: notification on/off, sound on/off, which sound (▶ to hear it), and a test. */
function AlertRow({ title, hint, banner, soundOn, sound, onBanner, onSoundOn, onSound, test }: {
  title: string; hint: string; banner: boolean; soundOn: boolean; sound: string
  onBanner: (v: boolean) => void; onSoundOn: (v: boolean) => void; onSound: (v: string) => void; test: () => Promise<string>
}) {
  const [sounds, setSounds] = useState<string[]>([])
  const [sent, setSent] = useState(false)
  const [result, setResult] = useState('')
  useEffect(() => { invoke<string[]>('list_sounds').then(setSounds, () => {}) }, [])
  return (
    <div class="field alert-row">
      <span>{title}<div class="hint" style={{ margin: 0 }}>{hint}</div></span>
      <span class="alert-ctl">
        <label><input type="checkbox" checked={banner} onChange={(e) => onBanner(e.currentTarget.checked)} /> Notification</label>
        <label><input type="checkbox" checked={soundOn} onChange={(e) => onSoundOn(e.currentTarget.checked)} /> Sound</label>
        <select aria-label={`${title}: sound`} disabled={!soundOn} value={sound} onChange={(e) => { onSound(e.currentTarget.value); invoke('preview_sound', { name: e.currentTarget.value }) }}>
          {(sounds.includes(sound) || !sound ? sounds : [sound, ...sounds]).map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        <button class="btn" title="Hear the sound" disabled={!soundOn} onClick={() => invoke('preview_sound', { name: sound })}>▶</button>
        <button class="btn" disabled={!banner && !soundOn} onClick={async () => { setSent(true); setResult(await test()); setSent(false) }}>{sent ? 'Sending…' : 'Send a test'}</button>
      </span>
      {result && <div class="test-result">{
        result === 'system' ? <span>✓ Sent. Didn't see it? A Focus mode (Do Not Disturb) hides banners.</span>
        : result === 'card' ? <span>✓ Shown in the top-right corner.</span>
        : result === 'shown' ? <span>✓ Played.</span>
        : <span class="warn">Couldn't show it ({result.replace('fallback:', '')}).</span>
      }</div>}
    </div>
  )
}
const COLORS: [string, string][] = [['', 'Menu bar colour'], ['#ffffff', 'White'], ['#34c759', 'Green'], ['#0a84ff', 'Blue'], ['#ff9f0a', 'Orange'], ['#ff453a', 'Red'], ['#bf5af2', 'Purple'], ['#ffd60a', 'Yellow']]
const presetScale = (c: MenuBarCfg) => c.scale > 0 ? c.scale : c.size === 'tiny' ? 0.85 : c.size === 'normal' ? 1.2 : 1
const presetGap = (c: MenuBarCfg) => c.gap_pt != null ? c.gap_pt : c.gap > 0 ? c.gap : c.spacing === 'tight' ? 3 : c.spacing === 'loose' ? 9 : 5.5
const MB_ITEMS: [string, string][] = [['agent', 'Agent status'], ['tokens', 'Tokens today'], ['net', 'Network ↑ ↓'], ['cpu', 'CPU'], ['temp', 'CPU temperature'], ['mem', 'Memory'], ['disk', 'Disk free'], ['battery', 'Battery'], ['clock', 'Clock']]
// Same keys as FONTS in menubar.rs (fonts every Mac has).
const FONTS: [string, string, string][] = [
  ['system', 'System (SF Pro)', 'system-ui'], ['rounded', 'SF Pro Rounded', 'ui-rounded'], ['mono', 'SF Mono', 'ui-monospace'],
  ['newyork', 'New York', 'ui-serif'],
  ['helvetica', 'Helvetica Neue', 'Helvetica Neue'], ['menlo', 'Menlo', 'Menlo'], ['monaco', 'Monaco', 'Monaco'],
  ['din', 'DIN Alternate', 'DIN Alternate'], ['futura', 'Futura', 'Futura'], ['avenir', 'Avenir', 'Avenir'],
  ['georgia', 'Georgia', 'Georgia'], ['verdana', 'Verdana', 'Verdana'],
]
const NO_STYLE: ItemStyle = { label: '', color: '', label_color: '', scale: 0, layout: '' }

function ColorPick({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <span class="swatches" role="radiogroup" aria-label={label}>
      {COLORS.map(([c, n]) => c ? (
        <button key={n} type="button" role="radio" aria-checked={value === c} title={n} aria-label={n} class="swatch" style={{ background: c }} onClick={() => onChange(c)} />
      ) : (
        <button key={n} type="button" role="radio" aria-checked={value === c} title="Follows the menu bar: black in light mode, white in dark mode" class="swatch-auto" onClick={() => onChange(c)}>Auto</button>
      ))}
      {/* Any colour: a rainbow circle (filled with the colour once one is picked) over the system picker. */}
      <label class="swatch swatch-any" data-on={String(!COLORS.some(([c]) => c === value))} title="Any colour" style={!COLORS.some(([c]) => c === value) ? { background: value } : undefined}>
        <input type="color" aria-label={`${label}: any colour`} value={value || '#ffffff'} onChange={(e) => onChange(e.currentTarget.value)} />
      </label>
    </span>
  )
}

/** Base64 RGBA pixels (2x) → an image at real size. */
const toUrl = (b64: string, w: number, h: number) => {
  const bin = atob(b64), px = new Uint8ClampedArray(bin.length)
  for (let i = 0; i < bin.length; i++) px[i] = bin.charCodeAt(i)
  const c = document.createElement('canvas'); c.width = w; c.height = h
  c.getContext('2d')!.putImageData(new ImageData(px, w, h), 0, 0)
  return c.toDataURL()
}

type PreviewImg = { width: number; height: number; light?: string; dark?: string; hidden?: number; text: string }

/** The menu-bar item as drawn, on a light and a dark bar. At most one render is in flight, so a
 *  slider being dragged never queues up stale frames; the latest value always wins. */
function Preview({ cfg }: { cfg: MenuBarCfg }) {
  const [img, setImg] = useState<{ light: string; dark: string; w: number; h: number; hidden: number } | { text: string } | null>(null)
  const want = useRef(cfg), busy = useRef(false), alive = useRef(true)
  const pump = () => {
    if (busy.current || !alive.current) return
    busy.current = true
    const asked = want.current
    invoke<PreviewImg>('menubar_preview', { cfg: asked }).then((r) => {
      if (!alive.current) return
      setImg(r.width && r.light && r.dark ? { light: toUrl(r.light, r.width, r.height), dark: toUrl(r.dark, r.width, r.height), w: r.width, h: r.height, hidden: r.hidden ?? 0 } : { text: r.text })
    }, () => {}).finally(() => { busy.current = false; if (want.current !== asked) pump() })
  }
  useEffect(() => { want.current = cfg; pump() }, [cfg])
  useEffect(() => { alive.current = true; const t = setInterval(pump, 2000); return () => { alive.current = false; clearInterval(t) } }, [])
  if (!img) return <div class="mb-preview"><div class="mb-bar light" /><div class="mb-bar dark" /></div>
  if ('text' in img) return <p class="hint">{cfg.items.length ? img.text : 'Nothing is shown: only the DeviceTally icon appears. Turn on an item on the left.'}</p>
  const size = { width: `${img.w / 2}px`, height: `${img.h / 2}px` }
  return (
    <div class="mb-preview">
      <div class="mb-bar light"><img alt="Menu bar preview, light" src={img.light} style={size} /></div>
      <div class="mb-bar dark"><img alt="Menu bar preview, dark" src={img.dark} style={size} /></div>
      <span class="hint" style={{ margin: 0 }}>Real size · {Math.round(img.w / 2)} pt wide
        {img.hidden > 0 && <b class="warn"> · {img.hidden} item{img.hidden > 1 ? 's' : ''} at the end left out to fit the maximum width (General)</b>}</span>
    </div>
  )
}

type ItemImg = { k: string; light: string; dark: string; w: number; h: number }

/** A realistic macOS menu bar with your items as they're drawn. Separate items are separate
 *  images you can click to select; the combined item is one image. Light or dark follows the system,
 *  and can be flipped. At most one render round is in flight while a slider moves. */
function BarPreview({ cfg, sel, select }: { cfg: MenuBarCfg; sel: string; select: (k: string) => void }) {
  const [imgs, setImgs] = useState<ItemImg[] | null>(null)
  const [hidden, setHidden] = useState(0)
  const [dark, setDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  // Start from how the real menu bar looks (it follows the wallpaper too, not only dark mode).
  useEffect(() => { invoke<boolean>('menubar_dark').then(setDark, () => {}) }, [])
  const want = useRef(cfg), busy = useRef(false), alive = useRef(true)
  const pump = () => {
    if (busy.current || !alive.current) return
    busy.current = true
    const asked = want.current
    const groups = asked.combined ? [{ k: 'all', cfg: asked }] : asked.items.map((k) => ({ k, cfg: { ...asked, items: [k] } }))
    Promise.all(groups.map((g) => invoke<PreviewImg>('menubar_preview', { cfg: g.cfg }).then((r) => ({ k: g.k, r }))))
      .then((rs) => {
        if (!alive.current) return
        setHidden(rs.reduce((a, x) => a + (x.r.hidden ?? 0), 0))
        setImgs(rs.filter((x) => x.r.width && x.r.light && x.r.dark).map((x) => ({ k: x.k, light: toUrl(x.r.light!, x.r.width, x.r.height), dark: toUrl(x.r.dark!, x.r.width, x.r.height), w: x.r.width, h: x.r.height })))
      }, () => {})
      .finally(() => { busy.current = false; if (want.current !== asked) pump() })
  }
  useEffect(() => { want.current = cfg; pump() }, [cfg])
  useEffect(() => { alive.current = true; const t = setInterval(pump, 2000); return () => { alive.current = false; clearInterval(t) } }, [])
  const total = (imgs ?? []).reduce((a, x) => a + x.w / 2, 0)
  return (
    <div class="bar-preview">
      <div class={`fake-bar ${dark ? 'dark' : 'light'}`}>
        <span class="fake-menus"><b></b><b>Finder</b><span>File</span><span>Edit</span><span>View</span></span>
        <span class={`fake-items ${cfg.combined ? '' : 'sep'}`}>
          {!imgs?.length && <span class="hint" style={{ margin: 0 }}>{cfg.items.length ? '' : 'Only the DeviceTally icon. Turn on an item on the left.'}</span>}
          {(imgs ?? []).map((x) => (
            <button key={x.k} class={`fake-item ${sel === x.k || (x.k === 'all' && sel === 'general') ? 'sel' : ''}`} title={x.k === 'all' ? 'Combined item' : `${MB_ITEMS.find((m) => m[0] === x.k)?.[1]}: click to change`} onClick={() => select(x.k === 'all' ? 'general' : x.k)}>
              <img alt="" src={dark ? x.dark : x.light} style={{ width: `${x.w / 2}px`, height: `${x.h / 2}px` }} />
            </button>
          ))}
          <svg class="fake-sys" width="17" height="13" viewBox="0 0 17 13" aria-hidden="true"><path d="M8.5 11.5l2-2.3a3 3 0 0 0-4 0zM4.3 7.2a6 6 0 0 1 8.4 0l1.3-1.5a8 8 0 0 0-11 0zM1.7 4.3a9.6 9.6 0 0 1 13.6 0l1.2-1.4a11.5 11.5 0 0 0-16 0z" fill="currentColor" /></svg>
          <span class="fake-clock">Sat 9:41</span>
        </span>
      </div>
      <div class="bar-caption">
        <span class="hint" style={{ margin: 0 }}>Real size · {Math.round(total)} pt{cfg.combined ? '' : ' · click an item to change it'}
          {hidden > 0 && <b class="warn"> · {hidden} left out to fit the maximum width</b>}</span>
        <Seg label="Menu bar" value={dark ? 'dark' : 'light'} options={[['light', 'Light'], ['dark', 'Dark']] as const} onChange={(v) => setDark(v === 'dark')} />
      </div>
    </div>
  )
}

/** Visual choices: each option shows a small example instead of a plain word. */
function Tiles<T extends string>({ value, options, onChange, label }: { value: T; options: [T, ComponentChildren, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div class="tiles" role="radiogroup" aria-label={label}>
      {options.map(([v, sample, name]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} class={`tile ${value === v ? 'on' : ''}`} onClick={() => onChange(v)}>
          <span class="tile-sample">{sample}</span><span class="tile-name">{name}</span>
        </button>
      ))}
    </div>
  )
}

// Example values for the tiles (what each item looks like with a label, an icon, or neither).
const SAMPLE: Record<string, [string, string]> = { tokens: ['T', '48M'], net: ['↑', '2.4M'], cpu: ['CPU', '23%'], temp: ['TEMP', '47°'], mem: ['MEM', '61%'], disk: ['SSD', '212G'], battery: ['BAT', '82%'], clock: ['', '9:41'] }
const SampleIcon = ({ k }: { k: string }) => <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{NAV_ICON[k]}</svg>
const Ring = ({ word }: { word?: boolean }) => <span class="ring-sample"><svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor" /><path d="M4.8 8.3l2 2 4.3-4.6" fill="none" stroke="var(--bg-tile, #fff)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>{word && <span>Done</span>}</span>

const SIZE_PRESETS: [number, string][] = [[70, 'Small'], [100, 'Normal'], [140, 'Large'], [200, 'Max']]
function SizeControl({ id, value, live, save }: { id: string; value: number; live: (v: number) => void; save: (v: number) => void }) {
  return (
    <div class="size-ctl">
      <div class="seg presets" role="group" aria-label="Size presets">
        {SIZE_PRESETS.map(([v, l]) => <button key={v} aria-pressed={value === v} onClick={() => save(v)}>{l}</button>)}
      </div>
      <span class="slider"><input id={id} type="range" min={50} max={200} step={5} value={value} aria-label="Size"
        onInput={(e) => live(Number(e.currentTarget.value))} onChange={(e) => save(Number(e.currentTarget.value))} /><b class="num">{value}%</b></span>
    </div>
  )
}

const Card = ({ title, children }: { title: string; children: ComponentChildren }) => <section class="mb-card"><h3>{title}</h3><div class="group">{children}</div></section>

/** A slider row: shows the value while dragging, calls `live` on every move and `save` on release. */
function Slider({ id, label, hint, min, max, step, value, fmt, live, save, reset }: {
  id: string; label: string; hint?: string; min: number; max: number; step: number; value: number; fmt: (v: number) => string
  live: (v: number) => void; save: (v: number) => void; reset?: () => void
}) {
  return (
    <div class="field"><label for={id}>{label}{hint && <div class="hint" style={{ margin: 0 }}>{hint}</div>}</label>
      <span class="slider"><input id={id} type="range" min={min} max={max} step={step} value={value}
        onInput={(e) => live(Number(e.currentTarget.value))} onChange={(e) => save(Number(e.currentTarget.value))} />
        <b class="num">{fmt(value)}</b>{reset && <button class="link-btn" onClick={reset}>Reset</button>}</span></div>
  )
}

const LABEL_OPTS: Record<string, [ItemStyle['label'], string][]> = {
  clock: [['', 'None'], ['icon', 'Icon']],
  agent: [['', 'Ring'], ['text', 'Ring + word']],
  net: [['', 'Default'], ['text', 'Arrows'], ['none', 'None']],
  battery: [['', 'Default'], ['text', 'Text'], ['icon', 'Icon'], ['inside', 'In icon'], ['none', 'None']],
}
const ITEM_HINT: Record<string, string> = {
  agent: 'What your coding agents are doing, with notifications and sounds when a task finishes or needs you. Claude Code and Codex.',
  tokens: "Today's tokens across your tracked accounts.",
  net: 'Upload and download speed of this computer.',
  cpu: 'How busy the processor is.',
  temp: 'The hottest CPU sensor. Not every computer reports one; then nothing shows.',
  mem: 'Memory in use.',
  disk: 'Free space on the system disk. Turns orange at 80% full and red at 90%.',
  battery: '"In icon" shows the percentage inside the battery, like the iPhone.',
  clock: 'Time, and optionally the day and date.',
}

/** One item's settings, in cards: what it shows, its size, its colours (and the clock's format). */
function ItemPane({ k, cfg, save, live }: { k: string; cfg: MenuBarCfg; save: (c: MenuBarCfg) => void; live: (c: MenuBarCfg) => void }) {
  const name = MB_ITEMS.find((x) => x[0] === k)![1]
  const on = cfg.items.includes(k)
  const st = { ...NO_STYLE, ...cfg.styles?.[k] }
  const with_ = (patch: Partial<ItemStyle>) => ({ ...cfg, styles: { ...cfg.styles, [k]: { ...st, ...patch } } })
  const c = cfg.clock
  const clock = (patch: Partial<ClockCfg>) => save({ ...cfg, clock: { ...c, ...patch } })
  const layout = st.layout || 'row'
  const insideBattery = k === 'battery' && st.label === 'inside'
  const [lab, val] = SAMPLE[k] ?? ['', '']
  const labelTiles: [ItemStyle['label'], ComponentChildren, string][] = k === 'agent'
    ? [['', <Ring />, 'Ring'], ['text', <Ring word />, 'Ring + word']]
    : k === 'clock'
      ? [['', <span>{val}</span>, 'Digital'], ['icon', <SampleIcon k="clock" />, 'Analog']]
      : k === 'net'
        ? [['', <span>{cfg.labels ? '↑ ' : ''}{val}</span>, 'Default'], ['text', <span>↑ {val}</span>, 'Arrows'], ['none', <span>{val}</span>, 'None']]
        : [['', <span>{cfg.labels ? <small>{lab} </small> : null}{val}</span>, 'Default'], ['text', <span><small>{lab} </small>{val}</span>, 'Text'], ['icon', <><SampleIcon k={k} /> {val}</>, 'Icon'],
          ...(k === 'battery' ? [['inside', <span class="bat-sample">{val.replace('%', '')}</span>, 'In icon'] as [ItemStyle['label'], ComponentChildren, string]] : []),
          ['none', <span>{val}</span>, 'None']]
  const layoutTiles: ['row' | 'stacked' | 'top', ComponentChildren, string][] = [
    ['row', <span><small>{lab || 'CPU'} </small>{val}</span>, 'Side by side'],
    ['stacked', <span class="stack2"><span><small>{lab || 'CPU'}</small> {val}</span><span><small>MEM</small> 61%</span></span>, 'Stacked'],
    ['top', <span class="stack2 center"><small>{lab || 'CPU'}</small><span>{val}</span></span>, 'Label on top'],
  ]
  return (
    <div class="mb-pane">
      <div class="mb-pane-head">
        <div class="mb-title"><span class="mb-title-icon"><NavIcon k={k} /></span><div><h2>{name}</h2><span class="hint" style={{ margin: 0 }}>{ITEM_HINT[k]}</span></div></div>
        <label class="switch"><span>{on ? 'Shown' : 'Hidden'}</span><input type="checkbox" class="toggle" checked={on} onChange={() => save({ ...cfg, items: on ? cfg.items.filter((x) => x !== k) : [...cfg.items, k] })} /></label>
      </div>
      {on ? <>
        <Card title="Show as">
          <div class="field col"><Tiles label="Label" value={st.label as ItemStyle['label']} options={labelTiles} onChange={(v) => save(with_({ label: v }))} /></div>
          {k !== 'net' && k !== 'agent' && !insideBattery && <div class="field col"><span class="field-label">Layout</span><Tiles label="Layout" value={layout} options={layoutTiles} onChange={(v) => save(with_({ layout: v }))} /></div>}
          {k === 'net' && <div class="field"><label for="mbn">Upload over download<div class="hint" style={{ margin: 0 }}>One narrow column instead of two side by side.</div></label>
            <input id="mbn" type="checkbox" checked={cfg.net_stack} onChange={(e) => save({ ...cfg, net_stack: e.currentTarget.checked })} /></div>}
        </Card>
        {k === 'agent' && <Card title="Look">
          <div class="field col"><span class="field-label">While working</span><Tiles label="While working" value={cfg.agent_motion || 'ring'} onChange={(v) => save({ ...cfg, agent_motion: v })} options={[
            ['ring', <span class="look-demo look-ring" />, 'Ring'], ['pulse', <span class="look-demo look-pulse" />, 'Pulse'], ['dots', <span class="look-demo look-dots"><i /><i /><i /></span>, 'Dots']]} /></div>
          <div class="field col"><span class="field-label">When done</span><Tiles label="When done" value={['burst', 'dot', 'spark'].includes(cfg.agent_done) ? cfg.agent_done : 'burst'} onChange={(v) => save({ ...cfg, agent_done: v })} options={[
            ['burst', <span class="look-done-spark">✺</span>, 'Burst'], ['dot', <span class="look-done-dot" />, 'Dot'], ['spark', <span class="look-done-spark">✦</span>, 'Spark']]} /></div>
        </Card>}
        <Card title="Size">
          <div class="field"><SizeControl id={`sz-${k}`} value={Math.round((st.scale || 1) * 100)} live={(v) => live(with_({ scale: v / 100 }))} save={(v) => save(with_({ scale: v / 100 }))} /></div>
        </Card>
        <Card title="Colour">
          {k === 'agent' && <div class="field"><label for="ringc">State colours<div class="hint" style={{ margin: 0 }}>Orange working, red needs you, green done. Off: the menu bar's own colour; the shapes still differ.</div></label>
            <input id="ringc" type="checkbox" checked={cfg.ring_color} onChange={(e) => save({ ...cfg, ring_color: e.currentTarget.checked })} /></div>}
          {(k !== 'agent' || st.label === 'text' || st.label === 'icon') && <div class="field"><span>{k === 'agent' ? 'Word' : insideBattery ? 'Battery' : 'Number'}</span><ColorPick label="Number colour" value={st.color} onChange={(v) => save(with_({ color: v }))} /></div>}
          {k !== 'net' && k !== 'agent' && !insideBattery && <div class="field"><span>{k === 'clock' ? 'Icon' : 'Label'}</span><ColorPick label="Label colour" value={st.label_color} onChange={(v) => save(with_({ label_color: v }))} /></div>}
        </Card>
        {k === 'clock' && st.label !== 'icon' && <Card title="Format">
          <div class="field"><span>Hours</span><Seg label="Hours" value={c.hour12 ? '12' : '24'} options={[['24', '24-hour'], ['12', '12-hour']] as const} onChange={(v) => clock({ hour12: v === '12' })} /></div>
          {c.hour12 && <div class="field"><label for="ck-ampm">Show AM/PM</label><input id="ck-ampm" type="checkbox" checked={c.ampm} onChange={(e) => clock({ ampm: e.currentTarget.checked })} /></div>}
          <div class="field"><label for="ck-wd">Day of the week (Sat)</label><input id="ck-wd" type="checkbox" checked={c.weekday} onChange={(e) => clock({ weekday: e.currentTarget.checked })} /></div>
          <div class="field"><label for="ck-d">Date (4)</label><input id="ck-d" type="checkbox" checked={c.day} onChange={(e) => clock({ day: e.currentTarget.checked })} /></div>
          <div class="field"><label for="ck-m">Month (Oct)</label><input id="ck-m" type="checkbox" checked={c.month} onChange={(e) => clock({ month: e.currentTarget.checked })} /></div>
          <Slider id="ck-sp" label="Space between parts" hint="Tightens a long date and time without changing the other items." min={0} max={3} step={1}
            value={CLOCK_SPACING.indexOf(c.spacing ?? '') < 0 ? 2 : CLOCK_SPACING.indexOf(c.spacing ?? '')} fmt={(v) => ['Tight', 'Thin', 'Normal', 'Wide'][v]}
            live={(v) => live({ ...cfg, clock: { ...c, spacing: CLOCK_SPACING[v] } })} save={(v) => clock({ spacing: CLOCK_SPACING[v] })} />
        </Card>}
        {k === 'agent' && <AgentAlerts cfg={cfg} save={save} live={live} />}
        {k === 'disk' && <DiskAlert cfg={cfg} save={save} />}
        <p class="hint">{k === 'agent' ? <>A ring turns while an agent works, ! when it needs you, ✓ when it's done. Click it in the menu bar to see each agent.</>
          : <><b>Auto</b> colour follows the menu bar. Drag items in the list on the left to reorder them.{(k === 'battery' || k === 'clock') && " Using DeviceTally's? Hide macOS's own in System Settings → Control Center."}</>}</p>
      </> : <>
        <div class="empty-pane"><p>Not in your menu bar.</p><button class="btn primary" onClick={() => save({ ...cfg, items: [...cfg.items, k] })}>Add to menu bar</button></div>
        {k === 'agent' && <AgentAlerts cfg={cfg} save={save} live={live} />}
        {k === 'disk' && <DiskAlert cfg={cfg} save={save} />}
      </>}
    </div>
  )
}

/** Settings shared by every item: one item or several, size, spacing, typeface. */
function GeneralPane({ cfg, save, live }: { cfg: MenuBarCfg; save: (c: MenuBarCfg) => void; live: (c: MenuBarCfg) => void }) {
  return (
    <div class="mb-pane">
      <div class="mb-pane-head"><div class="mb-title"><span class="mb-title-icon"><NavIcon k="general" /></span><div><h2>General</h2><span class="hint" style={{ margin: 0 }}>For every item. Each item's own look is under its name.</span></div></div></div>
      <div class="field" style={{ justifyContent: 'flex-end', padding: 0, border: 0 }}>
        <button class="btn" title="Keeps your items and their order" onClick={() => save({ ...cfg, font: 'system', weight: 'regular', label_color: '', value_color: '', ring_color: false, labels: true, layout: 'row', scale: 0, gap_pt: null, agent_motion: 'ring', agent_done: 'burst', styles: {} })}>Reset to the default look</button>
      </div>
      <Card title="Items">
        <div class="field col"><Tiles label="Items" value={cfg.combined ? 'one' : 'separate'} onChange={(v) => save({ ...cfg, combined: v === 'one' })} options={[
          ['separate', <span class="sep-sample"><i /><i /><i /></span>, 'Separate items · each opens its own panel'],
          ['one', <span class="sep-sample one"><i /></span>, 'One combined item · opens everything'],
        ]} /></div>
        {cfg.combined && <Slider id="mbw" label="Maximum width" hint="Items past it are left out. macOS hides a whole item that doesn't fit next to the notch, so a limit keeps the first items visible." min={80} max={1000} step={10} value={cfg.max_width > 0 ? cfg.max_width : 1000} fmt={(v) => (v >= 1000 ? 'No limit' : `${v} pt`)}
          live={(v) => live({ ...cfg, max_width: v >= 1000 ? 0 : v })} save={(v) => save({ ...cfg, max_width: v >= 1000 ? 0 : v })} />}
      </Card>
      <Card title="Text size">
        <div class="field"><SizeControl id="mbs" value={Math.round(presetScale(cfg) * 100)} live={(v) => live({ ...cfg, scale: v / 100 })} save={(v) => save({ ...cfg, scale: v / 100 })} /></div>
      </Card>
      <Card title="Typeface">
        <div class="field"><span>Weight</span><Seg label="Weight" value={cfg.weight} options={[['regular', 'Regular'], ['medium', 'Medium'], ['bold', 'Bold']] as const} onChange={(v) => save({ ...cfg, weight: v })} /></div>
        <div class="field"><label for="mbf">Font</label>
          <select id="mbf" value={cfg.font} onChange={(e) => save({ ...cfg, font: e.currentTarget.value })}>
            {FONTS.map(([k, l, css]) => <option key={k} value={k} style={{ fontFamily: css }}>{l}</option>)}
          </select></div>
        <div class="field"><label for="mbl">Labels when an item says "Default"<div class="hint" style={{ margin: 0 }}>T, CPU, MEM, arrows; spelled out with Label on top.</div></label>
          <input id="mbl" type="checkbox" checked={cfg.labels} onChange={(e) => save({ ...cfg, labels: e.currentTarget.checked })} /></div>
      </Card>
      <Card title="Spacing">
        <Slider id="mbg" label="Between items" hint={cfg.combined ? undefined : "The gap between DeviceTally\u2019s menu-bar items. 0 puts them right next to each other."} min={0} max={12} step={0.5} value={presetGap(cfg)} fmt={(v) => `${v} pt`} live={(v) => live({ ...cfg, gap_pt: v })} save={(v) => save({ ...cfg, gap_pt: v })} />
      </Card>
    </div>
  )
}

/** Agent notifications and sounds (inside Agent status; they work whether or not the ring is shown). */
function AgentAlerts({ cfg, save, live }: { cfg: MenuBarCfg; save: (c: MenuBarCfg) => void; live: (c: MenuBarCfg) => void }) {
  const a = cfg.alerts
  const set = (patch: Partial<MenuBarCfg['alerts']>) => save({ ...cfg, alerts: { ...a, ...patch } })
  return <>
    <Card title="Notifications and sounds">
      <AlertRow title="When a task finishes" hint="Claude Code and Codex" banner={a.done_banner} soundOn={a.done_sound_on} sound={a.done_sound}
        onBanner={(v) => set({ done_banner: v })} onSoundOn={(v) => set({ done_sound_on: v })} onSound={(v) => set({ done_sound: v })} test={() => invoke<string>('test_alert', { waiting: false }).catch((e) => `fallback:${e}`)} />
      <AlertRow title="When an agent needs you" hint="A permission or a question" banner={a.wait_banner} soundOn={a.wait_sound_on} sound={a.wait_sound}
        onBanner={(v) => set({ wait_banner: v })} onSoundOn={(v) => set({ wait_sound_on: v })} onSound={(v) => set({ wait_sound: v })} test={() => invoke<string>('test_alert', { waiting: true }).catch((e) => `fallback:${e}`)} />
      <Slider id="mbmin" label="Skip short tasks" hint={'No "finished" alert for quick replies.'} min={0} max={300} step={5} value={a.min_seconds} fmt={(v) => (v ? `${v} s` : 'Off')}
        live={(v) => live({ ...cfg, alerts: { ...a, min_seconds: v } })} save={(v) => set({ min_seconds: v })} />
    </Card>
    <p class="hint">These are normal Mac notifications from DeviceTally (style in System Settings → Notifications → DeviceTally). The sound plays with the notification and follows Focus; a sound alone always plays. Your own sounds: put files in ~/Library/Sounds.</p>
  </>
}

/** Disk alert (inside Disk free). */
function DiskAlert({ cfg, save }: { cfg: MenuBarCfg; save: (c: MenuBarCfg) => void }) {
  return (
    <Card title="Alert">
      <div class="field"><label for="mbdk">Notify when the disk is filling up<div class="hint" style={{ margin: 0 }}>At 80% and 90% full.</div></label>
        <input id="mbdk" type="checkbox" checked={cfg.alerts.disk_alert} onChange={(e) => save({ ...cfg, alerts: { ...cfg.alerts, disk_alert: e.currentTarget.checked } })} /></div>
    </Card>
  )
}

// Sidebar icons (simple line drawings, in the text colour).
const NAV_ICON: Record<string, ComponentChildren> = {
  general: <><path d="M3 5h10M3 11h10" /><circle cx="6" cy="5" r="1.6" fill="currentColor" /><circle cx="10" cy="11" r="1.6" fill="currentColor" /></>,
  alerts: <><path d="M4.5 11V7.5a3.5 3.5 0 0 1 7 0V11l1 1.2H3.5z" /><path d="M7 13.5a1.2 1.2 0 0 0 2 0" /></>,
  agent: <><circle cx="8" cy="8" r="5" /><path d="M5.8 8.2l1.5 1.5 3-3.2" /></>,
  tokens: <path d="M8 2.5l1.2 3.3 3.3 1.2-3.3 1.2L8 11.5 6.8 8.2 3.5 7l3.3-1.2z" />,
  net: <path d="M5.5 12.5v-9M3.5 5.5l2-2 2 2M10.5 3.5v9M8.5 10.5l2 2 2-2" />,
  cpu: <><rect x="4.5" y="4.5" width="7" height="7" rx="1" /><path d="M6.5 2.5v2M9.5 2.5v2M6.5 11.5v2M9.5 11.5v2M2.5 6.5h2M2.5 9.5h2M11.5 6.5h2M11.5 9.5h2" /></>,
  temp: <><path d="M7 3.5a1 1 0 0 1 2 0v5.3a2.5 2.5 0 1 1-2 0z" /></>,
  mem: <><rect x="2.5" y="5" width="11" height="5" rx="0.8" /><path d="M5 10v2M8 10v2M11 10v2M5 7v1M8 7v1M11 7v1" /></>,
  disk: <><rect x="2.5" y="5" width="11" height="6" rx="1.2" /><circle cx="11" cy="8" r="0.6" fill="currentColor" /></>,
  battery: <><rect x="2.5" y="5" width="10" height="6" rx="1.5" /><path d="M13.5 7v2" /><rect x="4" y="6.5" width="5" height="3" rx="0.6" fill="currentColor" stroke="none" /></>,
  clock: <><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3.2l2 1.3" /></>,
}
const NavIcon = ({ k }: { k: string }) => <svg class="nav-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{NAV_ICON[k]}</svg>

/** Menu bar tab, laid out like Stats: sections on the left, the selected one (with the live
 *  preview on top) on the right, at any window width. */
const IS_MAC = navigator.userAgent.includes('Mac')
const IS_LINUX = navigator.userAgent.includes('Linux')

/** Linux and Windows: trays show one icon with text (Linux) or a tooltip (Windows), not drawn
 *  items, and don't pass clicks to apps. What will show, and how to open DeviceTally. */
function OtherOsPane({ cfg }: { cfg: MenuBarCfg }) {
  const [text, setText] = useState('')
  useEffect(() => {
    const load = () => invoke<{ text: string }>('menubar_preview', { cfg: { ...cfg, combined: true } }).then((r) => setText(r.text), () => {})
    load()
    const t = setInterval(load, 2000)
    return () => clearInterval(t)
  }, [cfg])
  return (
    <div class="mb-pane">
      <Card title={IS_LINUX ? 'In the top bar' : 'In the system tray'}>
        <div class="field col"><span class="hint" style={{ margin: 0 }}>{IS_LINUX ? 'Next to the DeviceTally icon:' : 'When you point at the DeviceTally icon:'}</span>
          <div class="os-preview num">{text || 'Only the DeviceTally icon'}</div></div>
        <p class="hint" style={{ margin: 0 }}>Turn items on or off and drag them into order on the left. Colours, fonts, sizes and separate items are macOS-only.</p>
      </Card>
      <Card title="Opening DeviceTally">
        <p class="hint" style={{ margin: 0 }}>{IS_LINUX
          ? 'Click the DeviceTally icon to open its menu, then Open DeviceTally. (Linux trays open the menu on click.)'
          : 'Click the DeviceTally icon, or right-click it for its menu.'}</p>
        {IS_LINUX && <p class="hint" style={{ margin: 0 }}>Don't see the icon on GNOME (e.g. Debian or Fedora)? Install and turn on the "AppIndicator and KStatusNotifierItem Support" extension. Ubuntu has it on already.</p>}
      </Card>
    </div>
  )
}

function MenuBarTab() {
  const [cfg, setCfg] = useState<MenuBarCfg | null>(null)
  const [sel, setSel] = useState('general')
  const liveBusy = useRef(false), liveWant = useRef<MenuBarCfg | null>(null)
  useEffect(() => {
    invoke<MenuBarCfg>('get_menubar').then((c) => {
      // Older versions had a layout and colours "for every item" that silently overrode each
      // item's Auto; move them into the items once, so every value on screen is the real one.
      // The old "status dot" switch becomes the Agent status item (first in the menu bar).
      if (c.status_dot) {
        c = { ...c, status_dot: false, items: c.items.includes('agent') ? c.items : ['agent', ...c.items] }
        invoke('set_menubar', { cfg: c })
      }
      if (c.value_color || c.label_color || (c.layout && c.layout !== 'row')) {
        const styles = { ...c.styles }
        for (const [k] of MB_ITEMS) {
          const st = { ...NO_STYLE, ...styles[k] }
          styles[k] = { ...st, color: st.color || c.value_color, label_color: st.label_color || c.label_color, layout: st.layout || (c.layout !== 'row' ? c.layout : '') }
        }
        c = { ...c, styles, value_color: '', label_color: '', layout: 'row' }
        invoke('set_menubar', { cfg: c })
      }
      setCfg(c)
    })
  }, [])
  // Drag the grip to reorder items in the menu bar (pointer events: the webview's own drag and
  // drop isn't reliable). The rows are rendered by a plain function, not a component defined here,
  // so a re-render while dragging keeps the same elements.
  const [drag, setDrag] = useState<{ k: string; over: string } | null>(null)
  const cfgRef = useRef(cfg)
  const saveRef = useRef<((c: MenuBarCfg) => void) | null>(null)
  cfgRef.current = cfg
  // Listeners are added right in pointerdown (not in an effect), so even a quick flick is caught.
  const startDrag = (k: string) => {
    let over = k
    setDrag({ k, over })
    const move = (e: PointerEvent) => {
      const o = (document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-reorder]') as HTMLElement | null)?.dataset.reorder
      if (o && o !== over) { over = o; setDrag({ k, over }) }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      setDrag(null)
      const c = cfgRef.current
      if (!c || over === k) return
      const items = c.items.filter((x) => x !== k)
      const at = c.items.indexOf(over) > c.items.indexOf(k) ? items.indexOf(over) + 1 : items.indexOf(over)
      items.splice(at, 0, k)
      saveRef.current?.({ ...c, items })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }
  if (!cfg) return null
  const save = (next: MenuBarCfg) => { setCfg(next); liveWant.current = null; invoke('set_menubar', { cfg: next }) }
  // While dragging: the real menu bar follows too (not saved until release), one update at a time.
  const live = (next: MenuBarCfg) => {
    setCfg(next)
    liveWant.current = next
    const pump = () => {
      if (liveBusy.current || !liveWant.current) return
      liveBusy.current = true
      const c = liveWant.current
      invoke('set_menubar_live', { cfg: c }).finally(() => { liveBusy.current = false; if (liveWant.current && liveWant.current !== c) pump() })
    }
    pump()
  }
  const shown = cfg.items.map((k) => MB_ITEMS.find((x) => x[0] === k)!).filter(Boolean)
  const hidden = MB_ITEMS.filter(([k]) => !cfg.items.includes(k))
  const toggle = (k: string) => save({ ...cfg, items: cfg.items.includes(k) ? cfg.items.filter((x) => x !== k) : [...cfg.items, k] })
  saveRef.current = save
  const navItem = (k: string, l: string, on?: boolean) => (
    <div key={k} data-reorder={on ? k : undefined} class={`mb-nav-item ${sel === k ? 'active' : ''} ${on === false ? 'off' : ''} ${drag?.k === k ? 'dragging' : ''} ${drag && drag.over === k && drag.k !== k ? 'drop-here' : ''}`}>
      {on === true && <span class="grip" title="Drag to reorder" onPointerDown={(e) => { e.preventDefault(); startDrag(k) }}>⋮⋮</span>}
      <button class="mb-nav-btn" onClick={() => setSel(k)}><NavIcon k={k} /><span>{l}</span></button>
      {on !== undefined && <input type="checkbox" class="toggle" aria-label={`Show ${l}`} title={on ? 'Shown in the menu bar' : 'Not shown'} checked={on} onChange={() => toggle(k)} />}
    </div>
  )
  return (
    <div class="mb-split">
      <nav class="mb-side" aria-label="Menu bar sections">
        {navItem('general', 'General')}
        <div class="mb-nav-h">In the menu bar <span class="mb-nav-sub">drag to reorder</span></div>
        {shown.map(([k, l]) => navItem(k, l, true))}
        {!shown.length && <div class="hint" style={{ margin: '2px 10px' }}>Nothing yet</div>}
        {hidden.length > 0 && <div class="mb-nav-h">More</div>}
        {hidden.map(([k, l]) => navItem(k, l, false))}
      </nav>
      <div class="mb-main">
        {!IS_MAC ? <OtherOsPane cfg={cfg} /> : <>
          <div class="mb-top"><BarPreview cfg={cfg} sel={sel} select={setSel} /></div>
          {sel === 'general' ? <GeneralPane cfg={cfg} save={save} live={live} />
            : <ItemPane k={sel} cfg={cfg} save={save} live={live} />}</>}
      </div>
    </div>
  )
}

function SettingsTab({ st, refresh, signIn }: { st: Status; refresh: () => void; signIn?: boolean }) {
  const [prompts, setPrompts] = useState(false)
  const [adminSignIn, setAdminSignIn] = useState(!!signIn)
  if (prompts && st.signed_in) return <PromptsView back={() => setPrompts(false)} />
  if (!st.signed_in) {
    return (
      <div class="page">
        {st.local && !adminSignIn ? null : adminSignIn ? <div class="embedded-signin"><SignIn back={() => setAdminSignIn(false)} done={refresh} /></div> : (
          <section class="section"><h2>Admin</h2>
            <div class="group"><div class="field">
              <span>Not signed in. This window shows this computer only.</span>
              <button class="btn primary" onClick={() => setAdminSignIn(true)}>Sign in as admin</button>
            </div></div>
          </section>
        )}
        {st.this_device_connected && <DeviceSettings st={st} refresh={refresh} />}
        {st.local && <LocalGroup refresh={refresh} />}
        <AppGroup />
      </div>
    )
  }
  return (
    <div class="page">
      <ConnectionGroup st={st} refresh={refresh} />
      <ServerGroup />
      {st.this_device_connected && <LockGroup />}
      <AppGroup />
      <AdminSettings openPrompts={() => setPrompts(true)} />
    </div>
  )
}

/** "Just this computer": what that means, and the way to a server later (history moves along). */
function LocalGroup({ refresh }: { refresh: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <section class="section"><h2>Just this computer</h2>
      <div class="group">
        <div class="field"><span>DeviceTally runs without a server: usage is counted on this computer and nothing leaves it.<div class="hint" style={{ margin: 0 }}>Cost estimates and other computers need a server. Connecting later uploads the history kept here.</div></span>
          {!open && <button class="btn" onClick={() => setOpen(true)}>Connect to a server</button>}</div>
      </div>
      {open && <div class="embedded-signin"><Onboarding done={() => { setOpen(false); refresh() }} /></div>}
    </section>
  )
}

// ---------- Storage (this computer, read-only) ----------
type StorageItem = { group: string; name: string; about: string; risk: '' | 'safe' | 'caution' | 'risky'; path: string; bytes: number; trash: boolean }

/** Move to Bin, with a warning that grows with the risk: a click for safe caches, ticking "I
 *  understand" for caution, and typing the name for risky ones. */
function TrashConfirm({ item, done, cancel }: { item: StorageItem; done: () => void; cancel: () => void }) {
  const [ok, setOk] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const ready = item.risk === 'safe' || (ok && (item.risk !== 'risky' || typed.trim() === item.name))
  const go = async () => {
    setBusy(true); setErr('')
    try { await invoke('trash_path', { path: item.path }); done() } catch (x) { setErr(String(x)); setBusy(false) }
  }
  return (
    <div class="trash-confirm" role="alertdialog" aria-label={`Move ${item.name} to the Bin`}>
      <p style={{ margin: 0 }}><b>Move "{item.name}" ({gbText(item.bytes)}) to the Bin?</b> You can put it back from the Bin until you empty it; the space is freed only then.
        {' '}DeviceTally can't undo this and isn't responsible for anything you remove, so make sure nothing you need is inside. {item.risk === 'safe' ? 'This is a cache that rebuilds itself.' : item.about}</p>
      {item.risk !== 'safe' && <label><input type="checkbox" checked={ok} onChange={(e) => setOk(e.currentTarget.checked)} /> I understand{item.risk === 'risky' ? ' this may hold my own data' : ' this may need a large re-download'}</label>}
      {item.risk === 'risky' && <input aria-label="Type the name to confirm" placeholder={`Type "${item.name}" to confirm`} value={typed} onInput={(e) => setTyped(e.currentTarget.value)} />}
      {err && <p class="err" role="alert">{err}</p>}
      <span><button class="btn danger" disabled={!ready || busy} onClick={go}>{busy ? 'Moving…' : 'Move to Bin'}</button> <button class="btn" onClick={cancel}>Cancel</button></span>
    </div>
  )
}
const gbText = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e6)} MB`)
const RISK = { safe: ['Safe', 'Rebuilds or re-downloads by itself'], caution: ['Caution', 'Large re-download, or may hold things you made'], risky: ['Risky', 'May hold your own data'] } as const
let lastScan: { at: number; items: StorageItem[]; full: boolean } | null = null // kept while the window is open

const GROUP_LOOK: Record<string, [string, string]> = { 'AI tools': ['#bf5af2', '✦'], 'Developer caches': ['#0a84ff', '⌘'], 'Biggest folders': ['#8e8e93', '▤'] }

function StorageTab() {
  const [scan, setScan] = useState(lastScan)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [disk, setDisk] = useState<{ free: number; total: number } | null>(null)
  const [copied, setCopied] = useState('')
  const [trashing, setTrashing] = useState('')
  const [moved, setMoved] = useState('')
  useEffect(() => { invoke<{ disk_free: number; disk_total: number }>('system_stats').then((s) => setDisk({ free: s.disk_free, total: s.disk_total }), () => {}) }, [])
  const run = async () => {
    setBusy(true); setErr('')
    try {
      const r = await invoke<{ full_access: boolean; items: StorageItem[] }>('storage_scan')
      lastScan = { at: Date.now(), items: r.items, full: r.full_access }; setScan(lastScan)
    } catch (x) { setErr(String(x)) } finally { setBusy(false) }
  }
  const used = disk && disk.total ? (disk.total - disk.free) / disk.total : 0
  const groups = ['AI tools', 'Developer caches', 'Biggest folders']
  const sum = (g: string) => (scan?.items ?? []).filter((i) => i.group === g).reduce((a, r) => a + r.bytes, 0)
  const cleanable = (scan?.items ?? []).filter((i) => i.trash && i.risk === 'safe')
  const biggest = Math.max(1, ...(scan?.items ?? []).map((i) => i.bytes))
  const seg = (bytes: number) => disk && disk.total ? `${(bytes / disk.total) * 100}%` : '0%'
  const other = disk ? Math.max(0, disk.total - disk.free - sum('AI tools') - sum('Developer caches')) : 0
  return (
    <div class="page">
      {disk && (
        <section class="st-hero">
          <div class="st-hero-top">
            <div><div class="st-free num">{gbText(disk.free)} <span>free</span></div>
              <div class="hint" style={{ margin: 0 }}>of {gbText(disk.total)} · {Math.round(used * 100)}% used</div></div>
            <button class="btn primary" disabled={busy} onClick={run}>{busy ? 'Scanning…' : scan ? 'Scan again' : 'Scan this computer'}</button>
          </div>
          <div class="st-bar" aria-hidden="true">
            {scan && <><i style={{ width: seg(sum('AI tools')), background: GROUP_LOOK['AI tools'][0] }} /><i style={{ width: seg(sum('Developer caches')), background: GROUP_LOOK['Developer caches'][0] }} /></>}
            <i style={{ width: seg(scan ? other : disk.total - disk.free), background: used >= 0.9 ? '#ff453a' : used >= 0.8 ? '#ff9f0a' : 'var(--muted)', opacity: 0.55 }} />
          </div>
          {scan && <div class="st-legend">
            <span><i style={{ background: GROUP_LOOK['AI tools'][0] }} />AI tools {gbText(sum('AI tools'))}</span>
            <span><i style={{ background: GROUP_LOOK['Developer caches'][0] }} />Developer caches {gbText(sum('Developer caches'))}</span>
            <span><i style={{ background: 'var(--muted)' }} />Everything else</span>
          </div>}
          {busy && <div class="hint" style={{ margin: '8px 0 0' }}>Up to a minute on a full disk.</div>}
          {!scan && !busy && <div class="hint" style={{ margin: '8px 0 0' }}>Finds what AI models, developer caches and big folders take up, and what's safe to clean.</div>}
        </section>
      )}
      {scan && !scan.full && (
        <div class="st-access">
          <div><b>Scan everything, with no pop-ups</b><div class="hint" style={{ margin: 0 }}>Without Full Disk Access, DeviceTally skips folders macOS would ask about (Desktop, Documents, Downloads, other apps' data). Allow it once in System Settings, then scan again.</div></div>
          <button class="btn" onClick={() => invoke('open_full_disk_access')}>Open Full Disk Access</button>
        </div>
      )}
      {err && <p class="err" role="alert">{err}</p>}
      {moved && <div class="banner" role="status"><span>✓ "{moved}" is in the Bin. Empty the Bin to free the space (or put it back from there).</span><button class="btn" onClick={() => setMoved('')}>OK</button></div>}
      {scan && cleanable.length > 0 && (
        <div class="st-clean"><span class="st-clean-n num">{gbText(cleanable.reduce((a, r) => a + r.bytes, 0))}</span>
          <span>safe to clean in {cleanable.length} {cleanable.length === 1 ? 'cache' : 'caches'}: they rebuild themselves when needed. Look for <span class="risk safe">Safe</span> below.</span></div>
      )}
      {scan && groups.map((g) => {
        const rows = scan.items.filter((i) => i.group === g)
        if (!rows.length) return null
        const [col, glyph] = GROUP_LOOK[g]
        return (
          <section class="section" key={g}>
            <h2 class="st-h"><span class="st-glyph" style={{ background: col }}>{glyph}</span>{g}<span class="st-h-size num">{gbText(rows.reduce((a, r) => a + r.bytes, 0))}</span></h2>
            {g === 'Biggest folders' && <p class="hint" style={{ margin: '-4px 0 8px' }}>Folders over 1 GB; they can include the items above.</p>}
            <div class="st-list">
              {rows.map((r) => (
                <Fragment key={r.path}><div class="st-row">
                  <div class="st-main">
                    <div class="st-name"><b>{r.name}</b>{r.risk && <span class={`risk ${r.risk}`} title={RISK[r.risk][1]}>{RISK[r.risk][0]}</span>}</div>
                    {r.about && <div class="hint" style={{ margin: 0 }}>{r.about}</div>}
                    <button class="path" title="Copy the path" onClick={() => navigator.clipboard.writeText(r.path).then(() => setCopied(r.path))}>{r.path}{copied === r.path ? '  ✓ copied' : ''}</button>
                  </div>
                  <div class="st-size"><b class="num">{gbText(r.bytes)}</b><div class="st-mini"><i style={{ width: `${(r.bytes / biggest) * 100}%`, background: col }} /></div></div>
                  <span class="storage-actions">
                    <button class="btn" onClick={() => invoke('reveal_path', { path: r.path })}>{IS_MAC ? 'Show in Finder' : 'Show in folder'}</button>
                    {r.trash && <button class="btn" onClick={() => setTrashing(r.path)}>Move to Bin</button>}
                  </span>
                </div>
                {trashing === r.path && <TrashConfirm item={r} cancel={() => setTrashing('')} done={() => {
                  setTrashing(''); setMoved(r.name)
                  if (scan) { lastScan = { ...scan, items: scan.items.filter((x) => x.path !== r.path) }; setScan(lastScan) }
                }} />}
                </Fragment>
              ))}
            </div>
          </section>
        )
      })}
      {scan && <p class="hint">Move to Bin is offered for caches only, never for your documents, app data or the Claude Code transcripts DeviceTally reads. Things go to the Bin first, so you can put them back. "Safe" items rebuild themselves; check "Risky" ones carefully.</p>}
    </div>
  )
}

// ---------- Window shell ----------
// Admin: the app carries a newer server than the one running? Say so plainly, with the fix.
function ServerBanner() {
  const [state, setState] = useState<{ server: string; bundled: string; host?: string } | null>(null)
  const [open, setOpen] = useState(false)
  const [done, setDone] = useState(false)
  useEffect(() => {
    invoke<string>('bundled_server_version').then((b) =>
      api<{ version: string; host?: string }>('/meta').then((m) => setState({ server: m.version, bundled: b, host: m.host }), () => setState({ server: '', bundled: b })))
    // Updated from Settings → Server: the banner goes away.
    const hide = () => setState(null)
    window.addEventListener('dt:server-updated', hide)
    return () => window.removeEventListener('dt:server-updated', hide)
  }, [])
  if (done) return <div class="banner" role="status"><span>✓ Server updated. Reopen a tab to load it.</span><button class="btn" onClick={() => location.reload()}>Reload</button></div>
  if (!state || (state.server && !newer(state.bundled, state.server))) return null
  return (
    <div class="banner" role="status">
      <div style={{ flex: 1 }}>
        <span>{state.server ? `Your server is version ${state.server}; this app needs ${state.bundled}.` : `Your server is older than this app (${state.bundled}).`} Some screens can't load until it's updated.</span>
        {state.host === 'node' && <span> {SELF_HOSTED_UPDATE}</span>}
        {open && <UpdateServerForm close={() => setOpen(false)} done={() => setDone(true)} />}
      </div>
      {!open && state.host !== 'node' && <button class="btn primary" onClick={() => setOpen(true)}>Update server</button>}
    </div>
  )
}

export function AppTitle({ big }: { big?: boolean }) {
  const [v, setV] = useState('')
  const [test, setTest] = useState(false)
  useEffect(() => {
    import('@tauri-apps/api/app').then((m) => m.getVersion()).then(setV, () => {})
    invoke<boolean>('test_build').then(setTest, () => {})
  }, [])
  if (big) return (
    <span class="brand-big">
      <img src="/icon.png" alt="" width={40} height={40} />
      <span><b>DeviceTally</b><small>{v && `Version ${v}`}{test && <span class="test-badge" title="Started with npm run try: a local test build, not the installed app">TEST</span>}</small></span>
    </span>
  )
  return (
    <span class="app-title"><img src="/icon.png" alt="" width={18} height={18} /> DeviceTally{v && <span class="hint" style={{ margin: 0 }}>{v}</span>}
      {test && <span class="test-badge" title="Started with npm run try: a local test build, not the installed app">TEST</span>}</span>
  )
}

export function MainWindow() {
  const [st, setSt] = useState<Status | null>(null)
  const [tab, setTab] = useState(new URLSearchParams(location.search).get('tab') ?? 'overview')
  const [signIn, setSignIn] = useState(false)
  const refresh = () => invoke<Status>('status').then((s) => { setSt(s); if (s.signed_in) setSignIn(false) })
  useEffect(() => {
    refresh()
    const on = (e: Event) => setTab((e as CustomEvent<string>).detail)
    window.addEventListener('dt:tab', on)
    return () => window.removeEventListener('dt:tab', on)
  }, [])
  if (!st) return <div class="main" />
  const admin = st.signed_in
  const connected = admin || st.this_device_connected || !!st.local
  if (!connected) return <div class="main"><Onboarding done={refresh} /></div>
  const tabs: [string, string][] = admin
    ? [['overview', 'Overview'], ['sessions', 'Sessions'], ['devices', 'Devices'], ['menubar', 'Menu bar'], ['storage', 'Storage'], ['settings', 'Settings']]
    : st.local ? [['overview', 'My usage'], ['menubar', 'Menu bar'], ['storage', 'Storage'], ['settings', 'Settings']]
    : [['overview', 'My usage'], ['sessions', 'Sessions'], ['menubar', 'Menu bar'], ['storage', 'Storage'], ['settings', 'Settings']]
  const current = tabs.some(([k]) => k === tab) ? tab : tabs[0][0]
  return (
    <div class="main">
      <nav class="tabs" role="tablist">
        <AppTitle big />
        {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={current === k} onClick={() => setTab(k)}>{l}</button>)}
        {!admin && !st.local && <button class="btn tab-signin" onClick={() => { setSignIn(true); setTab('settings') }}>Sign in as admin</button>}
      </nav>
      {admin && <ServerBanner />}
      <main key={`${current}-${admin}`}>
        {current === 'overview' && <OverviewTab admin={admin} />}
        {current === 'sessions' && <SessionsTab admin={admin} />}
        {current === 'devices' && <DevicesTab server={st.server} />}
        {current === 'storage' && <StorageTab />}
        {current === 'menubar' && <MenuBarTab />}
        {current === 'settings' && <SettingsTab key={String(signIn)} st={st} refresh={refresh} signIn={signIn} />}
      </main>
    </div>
  )
}
