/**
 * RSM Cloud Agent — Windows 10 desktop companion (single self-contained .exe)
 * ────────────────────────────────────────────────────────────────────────────
 * Built with `bun build --compile --target=bun-windows-x64` — the Bun runtime
 * is embedded inside the executable, so it runs on a clean Windows 10 PC with
 * ZERO dependencies and NO installer framework.
 *
 * What it does on a fresh PC (double-click the downloaded .exe):
 *   1. INSTALLS ITSELF   → copies to %LOCALAPPDATA%\RSMCloudAgent, creates a
 *      Desktop shortcut + a Start Menu shortcut and registers an HKCU Run
 *      entry so it starts with Windows, then relaunches the installed copy.
 *   2. CONNECTS TO THE CLOUD → enrolls itself as a hybrid sync device
 *      (POST /api/hybrid/device/self with the enrollment key that was
 *      stamped into the .exe at download time) and receives its own device
 *      credentials (deviceId + deviceKey, shown exactly once).
 *   3. TWO-WAY SYNC, AUTOMATICALLY → speaks the platform's native
 *      rsm-hybrid/1 protocol (the same one the POS terminals use):
 *        · PULL  GET /api/hybrid/pull   (cloud → local JSON mirror)
 *        · PUSH  POST /api/hybrid/push  (local outbox files → cloud)
 *      Every 30 seconds, plus a full bootstrap snapshot on first run and a
 *      refresh every 6 hours. The cloud instance it talks to is the Vercel
 *      production deployment — the hub that connects GitHub (code), Vercel
 *      (hosting), Turso (replica), Inngest (jobs) and Neon (datastore).
 *   4. READY TO WORK RIGHT AWAY → opens a local dashboard on
 *      http://127.0.0.1:9753 with live 5-cloud status, sync statistics and
 *      one-click access to the cloud POS.
 *
 * Per-download configuration: the download route appends a small
 * `RSMCFG1:<base64>` JSON blob AFTER the executable bytes (a PE overlay —
 * the OS loader and the Bun runtime both ignore trailing data, verified by
 * test). The agent reads its own tail to learn its server URLs.
 *
 * Outbox (local → cloud changes): drop a JSON file into the agent's
 * `outbox` folder (path shown on the dashboard) with the shape
 *   { "entity": "Customer", "entityId": 941, "operation": "update",
 *     "payload": { …full row… }, "revision": 2 }
 * It is pushed on the next cycle, then archived to outbox/sent (or
 * outbox/dead when permanently rejected by the server's policy engine).
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { EOL, homedir, hostname, platform as osPlatform, release } from 'node:os'
import { join } from 'node:path'

// ─── constants ───────────────────────────────────────────────────────────────

const IS_WINDOWS = process.platform === 'win32'
const VERSION = '1.1.0'
const APP_TITLE = 'RSM Cloud Agent'
const EMBEDDED_MARKER = 'RSMCFG1:'

const INSTALL_DIR = IS_WINDOWS
  ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'RSMCloudAgent')
  : join(homedir(), '.rsm-cloud-agent')
const DATA_DIR = IS_WINDOWS
  ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'RSMCloudAgent')
  : INSTALL_DIR
const EXE_NAME = IS_WINDOWS ? 'RSM-CloudAgent.exe' : 'rsm-cloud-agent'
const INSTALLED_EXE = join(INSTALL_DIR, EXE_NAME)
const CONFIG_PATH = join(DATA_DIR, 'config.json')
const MIRROR_PATH = join(DATA_DIR, 'mirror.json')
const LOG_PATH = join(DATA_DIR, 'agent.log')
const OUTBOX_DIR = join(DATA_DIR, 'outbox')
const OUTBOX_SENT = join(OUTBOX_DIR, 'sent')
const OUTBOX_DEAD = join(OUTBOX_DIR, 'dead')

const DASHBOARD_PORT_BASE = 9753
const SYNC_INTERVAL_MS = 30_000
const CATCHUP_INTERVAL_MS = 2_000
const BOOTSTRAP_REFRESH_MS = 6 * 60 * 60 * 1000
const PULL_LIMIT = 200
const PULL_PAGES_PER_CYCLE = 25
const PUSH_BATCH = 50
const FETCH_TIMEOUT_MS = 20_000
const FAIL_STREAK_BEFORE_FAILOVER = 3

/** Durable production hub (Vercel + Neon + Turso + Inngest + GitHub). */
const DEFAULT_CLOUD_URL = 'https://wedjatrsm-tonsy.vercel.app'

// ─── types ───────────────────────────────────────────────────────────────────

type EmbeddedConfig = {
  v?: number
  baseUrl?: string
  cloudUrl?: string
  enrollKey?: string
  gen?: string
}

type AgentConfig = {
  baseUrl: string
  /** the durable cloud hub — the server we always prefer (v1.1) */
  primaryUrl?: string
  fallbackUrl: string
  cloudUrl: string
  enrollKey?: string
  deviceId?: string
  deviceKey?: string
  cursor: number
  bootstrapAt?: string
  installedAt?: string
  enrolledAt?: string
}

type WireEvent = {
  cursorId: number
  eventId: string
  deviceId: string
  entity: string
  entityId: number
  operation: 'create' | 'update' | 'delete'
  revision: number
  payloadHash: string
  payload: Record<string, unknown>
  createdAt: string
}

type CloudStatus = {
  id: string
  label: string
  status: 'connected' | 'configured' | 'unreachable' | 'not-configured' | 'unknown'
  detail: string
  latencyMs: number | null
}

type AgentState = {
  app: { title: string; version: string; platform: string; startedAt: string }
  install: { installed: boolean; installDir: string; dataDir: string; autoStart: boolean }
  device: { deviceId: string | null; enrolled: boolean; enrolledAt: string | null }
  server: {
    baseUrl: string
    cloudUrl: string
    connected: boolean
    lastContactAt: string | null
    lastError: string | null
    usingFallback: boolean
  }
  clouds: CloudStatus[]
  sync: {
    lastPullAt: string | null
    lastPushAt: string | null
    lastBootstrapAt: string | null
    eventsPulled: number
    eventsPushed: number
    conflicts: number
    remaining: number
    cursor: number
    pendingOutbox: number
    lastError: string | null
  }
  mirrorCounts: Record<string, number>
  mirrorTotal: number
  dashboardUrl: string
  outboxDir: string
}

// ─── small utilities ─────────────────────────────────────────────────────────

const nowIso = () => new Date().toISOString()
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const logLine = (msg: string) => `[${new Date().toISOString().slice(11, 19)}] ${msg}`

function log(msg: string, opts: { silent?: boolean } = {}): void {
  if (!opts.silent) console.log(logLine(msg))
  try {
    const st = statSync(LOG_PATH)
    if (st.size > 2_000_000) {
      try {
        renameSync(LOG_PATH, `${LOG_PATH}.old`)
      } catch {
        /* keep appending if rotate fails */
      }
    }
  } catch {
    /* no log file yet */
  }
  try {
    appendFileSync(LOG_PATH, `${logLine(msg)}${EOL}`)
  } catch {
    /* read-only dir — console only */
  }
}

function fatal(msg: string): never {
  console.error(`\n  ✗ ${msg}\n`)
  log(`FATAL: ${msg}`)
  if (IS_WINDOWS && process.stdin.isTTY) {
    // keep the double-clicked console open long enough to read the error
    process.stdout.write('  Press Enter to close…')
    process.stdin.resume()
    process.stdin.once('data', () => process.exit(1))
    // block the main thread until the user presses Enter
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  }
  process.exit(1)
}

/** Canonical JSON — identical algorithm to src/lib/hybrid-sync/serialization.ts
 *  (keys sorted recursively, no whitespace) so payload hashes match the server. */
function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return value.map(canonicalize)
  if (typeof value === 'object') {
    const src = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(src).sort()) {
      if (src[key] === undefined) continue
      out[key] = canonicalize(src[key])
    }
    return out
  }
  return value
}
const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value))
const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

// ─── embedded per-download config (PE overlay tail) ──────────────────────────

function readEmbeddedConfig(): EmbeddedConfig | null {
  try {
    const fd = openSync(process.execPath, 'r')
    try {
      const size = fstatSync(fd).size
      const len = Math.min(4096, size)
      const buf = Buffer.alloc(len)
      readSync(fd, buf, 0, len, size - len)
      const tail = buf.toString('utf8')
      const m = tail.match(/RSMCFG1:([A-Za-z0-9+/=._:-]+)/)
      if (!m) return null
      return JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) as EmbeddedConfig
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

// ─── config + mirror persistence (plain JSON — no native deps) ───────────────

let config: AgentConfig = {
  baseUrl: DEFAULT_CLOUD_URL,
  fallbackUrl: DEFAULT_CLOUD_URL,
  cloudUrl: DEFAULT_CLOUD_URL,
  cursor: 0,
}
let mirror: Record<string, Record<number, Record<string, unknown>>> = {}
let mirrorDirty = false

function loadConfig(): void {
  try {
    if (!existsSync(CONFIG_PATH)) return
    const saved = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Partial<AgentConfig>
    config = { ...config, ...saved }
  } catch {
    /* corrupted config → defaults (re-enrolls as a new device) */
  }
}
function saveConfig(): void {
  try {
    writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}${EOL}`)
  } catch (err) {
    log(`config save failed: ${String(err)}`, { silent: true })
  }
}
function loadMirror(): void {
  try {
    if (!existsSync(MIRROR_PATH)) return
    mirror = JSON.parse(readFileSync(MIRROR_PATH, 'utf8')) as typeof mirror
  } catch {
    /* corrupted mirror → refreshed by the next bootstrap */
  }
}
function saveMirror(): void {
  try {
    writeFileSync(MIRROR_PATH, JSON.stringify(mirror))
    mirrorDirty = false
  } catch (err) {
    log(`mirror save failed: ${String(err)}`, { silent: true })
  }
}

// ─── agent state (dashboard source of truth) ─────────────────────────────────

const state: AgentState = {
  app: { title: APP_TITLE, version: VERSION, platform: `${osPlatform()} ${release()}`, startedAt: nowIso() },
  install: { installed: false, installDir: INSTALL_DIR, dataDir: DATA_DIR, autoStart: false },
  device: { deviceId: null, enrolled: false, enrolledAt: null },
  server: {
    baseUrl: DEFAULT_CLOUD_URL,
    cloudUrl: DEFAULT_CLOUD_URL,
    connected: false,
    lastContactAt: null,
    lastError: null,
    usingFallback: false,
  },
  clouds: [],
  sync: {
    lastPullAt: null,
    lastPushAt: null,
    lastBootstrapAt: null,
    eventsPulled: 0,
    eventsPushed: 0,
    conflicts: 0,
    remaining: 0,
    cursor: 0,
    pendingOutbox: 0,
    lastError: null,
  },
  mirrorCounts: {},
  mirrorTotal: 0,
  dashboardUrl: `http://127.0.0.1:${DASHBOARD_PORT_BASE}`,
  outboxDir: OUTBOX_DIR,
}

function refreshMirrorCounts(): void {
  const counts: Record<string, number> = {}
  let total = 0
  for (const [entity, rows] of Object.entries(mirror)) {
    counts[entity] = Object.keys(rows).length
    total += counts[entity]
  }
  state.mirrorCounts = counts
  state.mirrorTotal = total
  state.sync.cursor = config.cursor
}

// ─── HTTP (device-authenticated against the cloud) ──────────────────────────

class HttpError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function api<T>(path: string, init: { method?: string; body?: unknown; auth?: boolean; timeoutMs?: number; baseUrl?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'
  const useAuth = init.auth !== false
  if (useAuth && config.deviceId && config.deviceKey) {
    headers['x-hybrid-device'] = config.deviceId
    headers['x-hybrid-key'] = config.deviceKey
  }
  const base = (init.baseUrl ?? config.baseUrl).replace(/\/$/, '')
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(init.timeoutMs ?? FETCH_TIMEOUT_MS),
  })
  const data = (await res.json().catch(() => ({}))) as { error?: string }
  if (!res.ok) throw new HttpError(data.error ?? `HTTP ${res.status}`, res.status)
  return data as T
}

function isNetworkError(err: unknown): boolean {
  return !(err instanceof HttpError)
}

// ─── enrollment (device credentials, shown exactly once by the server) ───────

async function ensureEnrolled(): Promise<void> {
  if (config.deviceId && config.deviceKey) {
    state.device = { deviceId: config.deviceId, enrolled: true, enrolledAt: config.enrolledAt ?? null }
    return
  }
  if (!config.enrollKey) {
    log('no enrollment key embedded — waiting (drop one into config.json as "enrollKey" and restart)')
    state.server.lastError = 'not enrolled (missing enrollment key)'
    return
  }
  const res = await api<{ deviceId: string; deviceKey: string }>('/api/hybrid/device/self', {
    method: 'POST',
    auth: false,
    body: {
      name: `${hostname()} · Windows Agent`,
      platform: IS_WINDOWS ? 'windows-agent' : `${process.platform}-agent`,
      enrollKey: config.enrollKey,
    },
  })
  config.deviceId = res.deviceId
  config.deviceKey = res.deviceKey
  config.enrolledAt = nowIso()
  saveConfig()
  state.device = { deviceId: config.deviceId, enrolled: true, enrolledAt: config.enrolledAt }
  log(`enrolled as hybrid device ${config.deviceId.slice(0, 8)}… — two-way sync unlocked`)
}

// ─── bootstrap (full snapshot → local mirror) ────────────────────────────────

async function bootstrap(): Promise<void> {
  const res = await api<{ format: string; generatedAt: string; tables: Record<string, Array<Record<string, unknown>>> }>(
    '/api/hybrid/bootstrap',
  )
  const next: typeof mirror = {}
  for (const [entity, rows] of Object.entries(res.tables ?? {})) {
    const table: Record<number, Record<string, unknown>> = {}
    for (const row of rows) {
      const id = Number(row.id)
      if (Number.isInteger(id) && id > 0) table[id] = row
    }
    next[entity] = table
  }
  mirror = next
  config.bootstrapAt = res.generatedAt
  saveMirror()
  saveConfig()
  state.sync.lastBootstrapAt = res.generatedAt
  refreshMirrorCounts()
  log(`bootstrap complete — ${state.mirrorTotal.toLocaleString()} rows across ${Object.keys(mirror).length} entities (snapshot ${res.generatedAt.slice(0, 19)}Z)`)
}

// ─── pull (cloud → mirror) ───────────────────────────────────────────────────

function applyEvent(evt: WireEvent): void {
  const table = mirror[evt.entity] ?? (mirror[evt.entity] = {})
  if (evt.operation === 'delete') delete table[evt.entityId]
  else table[evt.entityId] = evt.payload
  mirrorDirty = true
}

async function pullCycle(): Promise<void> {
  let pages = 0
  while (pages < PULL_PAGES_PER_CYCLE) {
    const res = await api<{ events: WireEvent[]; nextCursor: number; remaining: number }>(
      `/api/hybrid/pull?cursor=${config.cursor}&limit=${PULL_LIMIT}`,
    )
    let applied = 0
    for (const evt of res.events ?? []) {
      // Events older than the bootstrap snapshot are already baked into the
      // mirror — skip them (they would regress fresher rows).
      if (config.bootstrapAt && evt.createdAt <= config.bootstrapAt) continue
      applyEvent(evt)
      applied++
    }
    config.cursor = res.nextCursor ?? config.cursor
    state.sync.remaining = res.remaining ?? 0
    state.sync.eventsPulled += applied
    pages++
    if ((res.events ?? []).length === 0 || (res.remaining ?? 0) <= 0) break
  }
  state.sync.lastPullAt = nowIso()
  if (mirrorDirty) {
    saveMirror()
    refreshMirrorCounts()
  }
}

// ─── push (outbox files → cloud) ─────────────────────────────────────────────

function moveOutboxFile(fromDir: string, toDir: string, name: string): void {
  try {
    const target = join(toDir, name)
    if (existsSync(target)) renameSync(target, join(toDir, `${Date.now()}-${name}`))
    renameSync(join(fromDir, name), join(toDir, name))
  } catch (err) {
    log(`outbox archive failed for ${name}: ${String(err)}`, { silent: true })
  }
}

function listOutboxFiles(): string[] {
  try {
    return readdirSync(OUTBOX_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

async function pushCycle(): Promise<void> {
  const files = listOutboxFiles().slice(0, PUSH_BATCH)
  state.sync.pendingOutbox = Math.max(0, listOutboxFiles().length - files.length)
  if (files.length === 0) return
  if (!config.deviceId) return

  const events: Array<Record<string, unknown>> = []
  const byName = new Map<string, string>() // file → eventId
  for (const name of files) {
    try {
      const raw = JSON.parse(readFileSync(join(OUTBOX_DIR, name), 'utf8')) as Record<string, unknown>
      const entity = String(raw.entity ?? '')
      const entityId = Number(raw.entityId)
      const operation = String(raw.operation ?? '')
      const revision = Number.isInteger(raw.revision) && Number(raw.revision) >= 1 ? Number(raw.revision) : 1
      const payload = raw.payload
      if (
        !entity ||
        !Number.isInteger(entityId) ||
        entityId <= 0 ||
        !['create', 'update', 'delete'].includes(operation) ||
        !payload ||
        typeof payload !== 'object' ||
        Array.isArray(payload)
      ) {
        throw new Error('malformed outbox file')
      }
      const canonical = canonicalJson(payload)
      const eventId = randomUUID()
      events.push({
        eventId,
        deviceId: config.deviceId,
        entity,
        entityId,
        operation,
        revision,
        payloadHash: sha256Hex(canonical),
        payload: JSON.parse(canonical) as Record<string, unknown>,
      })
      byName.set(name, eventId)
    } catch {
      moveOutboxFile(OUTBOX_DIR, OUTBOX_DEAD, name)
    }
  }
  if (events.length === 0) return

  const res = await api<{ acked: string[]; rejected: Array<{ eventId: string; reason: string }>; conflicts: unknown[] }>(
    '/api/hybrid/push',
    { method: 'POST', body: { events } },
  )
  let pushed = 0
  for (const [name, eventId] of byName) {
    if (res.rejected?.some((r) => r.eventId === eventId)) {
      moveOutboxFile(OUTBOX_DIR, OUTBOX_DEAD, name)
    } else if (res.acked?.includes(eventId)) {
      moveOutboxFile(OUTBOX_DIR, OUTBOX_SENT, name)
      pushed++
    }
    // neither acked nor rejected → the receiver could not apply it yet
    // (usually a missing FK parent) — leave the file for a later cycle.
  }
  state.sync.eventsPushed += pushed
  state.sync.conflicts += res.conflicts?.length ?? 0
  state.sync.lastPushAt = nowIso()
  state.sync.pendingOutbox = listOutboxFiles().length
}

// ─── 5-cloud status (server-side checks, cached by the server) ───────────────

async function cloudStatusCycle(): Promise<void> {
  try {
    const res = await api<{ checkedAt: string; platforms: CloudStatus[] }>('/api/agent/cloud-status')
    state.clouds = res.platforms ?? []
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      // older server build — fall back to a single connected-cloud verdict
      state.clouds = [
        { id: 'cloud', label: 'RSM Cloud', status: 'connected', detail: config.baseUrl, latencyMs: null },
      ]
    } else {
      throw err
    }
  }
}

// ─── sync cycle + server failover ────────────────────────────────────────────

let failStreak = 0

/** Toggle between the cloud hub (preferred) and the download origin
 *  (fallback). v1.1: the original primary is remembered in config.primaryUrl
 *  so the agent returns to the hub once the fallback also starts failing —
  * v1.0 could flip to the fallback and then get stuck there forever. */
function switchServer(): void {
  const from = config.baseUrl
  const primary = config.primaryUrl ?? config.fallbackUrl
  config.baseUrl = config.baseUrl === primary ? config.fallbackUrl : primary
  state.server.usingFallback = config.baseUrl !== primary
  saveConfig()
  state.server.baseUrl = config.baseUrl
  log(`server failover: ${from} → ${config.baseUrl}`)
}

async function syncCycle(): Promise<void> {
  try {
    await ensureEnrolled()
    if (!config.deviceId || !config.deviceKey) return
    if (!config.bootstrapAt) await bootstrap()
    await cloudStatusCycle()
    await pushCycle()
    await pullCycle()
    if (config.bootstrapAt && Date.now() - Date.parse(config.bootstrapAt) > BOOTSTRAP_REFRESH_MS) {
      await bootstrap()
    }
    failStreak = 0
    state.server.connected = true
    state.server.lastContactAt = nowIso()
    state.server.lastError = null
    state.sync.lastError = null
    const cloudLine = state.clouds.length
      ? state.clouds.map((c) => `${c.label} ${c.status === 'connected' ? '✓' : c.status === 'configured' ? '○' : '✗'}`).join(' ')
      : ''
    log(
      `sync ok — pull ${state.sync.eventsPulled} · push ${state.sync.eventsPushed} · queued ${state.sync.remaining} · mirror ${state.mirrorTotal.toLocaleString()} rows${cloudLine ? ` · ${cloudLine}` : ''}`,
    )
  } catch (err) {
    failStreak++
    const msg = err instanceof Error ? err.message : String(err)
    state.server.connected = false
    state.server.lastError = msg
    state.sync.lastError = msg
    log(`sync failed (${failStreak}): ${msg}`)
    // v1.1: each server keeps its OWN device registry — after a failover the
    // credentials from the other server are rejected (401). When that
    // happens, drop the credentials and let the next cycle re-enroll against
    // the CURRENT server (bounded by the server's enrollment rate limit).
    if (err instanceof HttpError && err.status === 401 && config.deviceId && config.enrollKey) {
      log('credentials rejected by this server — re-enrolling as a new device here')
      config.deviceId = undefined
      config.deviceKey = undefined
      config.enrolledAt = undefined
      saveConfig()
      state.device = { deviceId: null, enrolled: false, enrolledAt: null }
      return
    }
    if (isNetworkError(err) && failStreak >= FAIL_STREAK_BEFORE_FAILOVER) switchServer()
  } finally {
    if (mirrorDirty) {
      saveMirror()
      refreshMirrorCounts()
    }
  }
}

// ─── local dashboard (127.0.0.1 only) ────────────────────────────────────────

function cloudBadge(c: CloudStatus): string {
  if (c.status === 'connected') return `<span class="pill ok">connected</span>`
  if (c.status === 'configured') return `<span class="pill cfg">configured</span>`
  if (c.status === 'not-configured') return `<span class="pill off">not configured</span>`
  return `<span class="pill bad">unreachable</span>`
}

function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${APP_TITLE}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Segoe UI", system-ui, sans-serif; background: #faf9f7; color: #292524; }
  .wrap { max-width: 880px; margin: 0 auto; padding: 24px 16px 48px; }
  header { display: flex; align-items: center; gap: 14px; padding-bottom: 18px; border-bottom: 2px solid #e7e5e4; }
  .logo { width: 46px; height: 46px; border-radius: 12px; background: linear-gradient(135deg,#f59e0b,#ea580c); display: grid; place-items: center; color: #fff; font-weight: 800; font-size: 15px; }
  h1 { font-size: 20px; margin: 0; } .sub { color: #78716c; font-size: 13px; margin-top: 2px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-top: 18px; }
  .card { background: #fff; border: 1px solid #e7e5e4; border-radius: 12px; padding: 12px 14px; }
  .card h3 { margin: 0 0 4px; font-size: 13px; color: #78716c; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }
  .big { font-size: 22px; font-weight: 700; }
  .pill { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 11px; font-weight: 700; }
  .pill.ok { background: #d1fae5; color: #065f46; } .pill.cfg { background: #fef3c7; color: #92400e; }
  .pill.bad { background: #fee2e2; color: #991b1b; } .pill.off { background: #f5f5f4; color: #78716c; }
  .cloud { display: flex; align-items: center; justify-content: space-between; gap: 8px; background: #fff; border: 1px solid #e7e5e4; border-radius: 12px; padding: 12px 14px; }
  .cloud b { font-size: 14px; } .cloud small { color: #78716c; display: block; margin-top: 2px; }
  section { margin-top: 26px; } h2 { font-size: 15px; margin: 0 0 10px; }
  table { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #e7e5e4; border-radius: 12px; overflow: hidden; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #f0efee; font-size: 13px; }
  th { background: #f5f5f4; color: #57534e; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  tr:last-child td { border-bottom: 0; }
  .btn { display: inline-block; background: #d97706; color: #fff; text-decoration: none; font-weight: 700; font-size: 14px; padding: 10px 18px; border-radius: 10px; }
  .muted { color: #78716c; font-size: 12px; }
  code { background: #f5f5f4; border-radius: 6px; padding: 2px 6px; font-size: 12px; }
  footer { margin-top: 32px; padding-top: 14px; border-top: 1px solid #e7e5e4; font-size: 12px; color: #a8a29e; }
</style></head>
<body><div class="wrap">
  <header>
    <div class="logo">RSM</div>
    <div style="flex:1">
      <h1>${APP_TITLE} <span class="muted">v${VERSION}</span></h1>
      <div class="sub" id="sub">connecting…</div>
    </div>
    <a class="btn" id="openCloud" href="#" target="_blank" rel="noreferrer">Open RSM Cloud</a>
  </header>

  <div class="cards" id="stats"></div>

  <section><h2>Cloud platforms · منصات السحابة</h2><div style="display:grid;gap:8px" id="clouds">
    <div class="muted">checking…</div></div></section>

  <section><h2>Local data mirror · النسخة المحلية</h2>
    <table id="mirror"><tr><td class="muted">waiting for the first sync…</td></tr></table></section>

  <section><h2>Push changes to the cloud · إرسال تغييرات للسحابة</h2>
    <div class="card" style="padding:16px">
      <p style="margin:0 0 8px;font-size:13px;line-height:1.6">
        Drop a JSON file into <code id="outboxPath">…</code> with the shape
        <code>{ "entity": "Customer", "entityId": 941, "operation": "update", "payload": { …full row… } }</code>
        — it is pushed on the next sync cycle (every 30&nbsp;seconds), then archived to
        <code>outbox/sent</code> (or <code>outbox/dead</code> when the server rejects it).
      </p>
      <p class="muted" style="margin:0">Queue right now: <b id="pending">0</b> file(s)</p>
    </div></section>

  <footer>
    ${APP_TITLE} — installs to <code id="installPath">…</code> · data in <code id="dataPath">…</code><br>
    Two-way sync over the platform's native rsm-hybrid/1 protocol. Keep this window (or the
    background process) running for continuous sync. Uninstall: remove the shortcut, delete
    <code id="uninstPath">…</code> and the HKCU\\…\\Run "RSMCloudAgent" entry.
  </footer>
</div>
<script>
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function tick() {
  try {
    // gateway-aware: when the dashboard is viewed through a port-transforming
    // gateway (e.g. a sandbox preview at /?XTransformPort=9753), the /api/state
    // fetch must carry the same query so the gateway routes it back here.
    const gw = location.search.includes('XTransformPort') ? location.search : '';
    const s = await (await fetch('/api/state' + gw)).json();
    document.getElementById('sub').textContent =
      (s.server.connected ? '● connected — two-way sync live' : '○ offline — retrying')
      + ' · ' + (s.device.deviceId ? 'device ' + s.device.deviceId.slice(0, 8) + '…' : 'not enrolled yet');
    document.getElementById('openCloud').href = s.server.cloudUrl;
    document.getElementById('outboxPath').textContent = s.outboxDir;
    document.getElementById('installPath').textContent = s.install.installDir;
    document.getElementById('dataPath').textContent = s.install.dataDir;
    document.getElementById('uninstPath').textContent = s.install.installDir;
    document.getElementById('pending').textContent = s.sync.pendingOutbox;
    document.getElementById('stats').innerHTML = [
      ['Mirror rows', s.mirrorTotal.toLocaleString()],
      ['Events pulled', s.sync.eventsPulled.toLocaleString()],
      ['Events pushed', s.sync.eventsPushed.toLocaleString()],
      ['Queue remaining', s.sync.remaining.toLocaleString()],
      ['Last pull', s.sync.lastPullAt ? new Date(s.sync.lastPullAt).toLocaleTimeString() : '—'],
      ['Last push', s.sync.lastPushAt ? new Date(s.sync.lastPushAt).toLocaleTimeString() : '—'],
    ].map(([k, v]) => '<div class="card"><h3>' + k + '</h3><div class="big">' + esc(v) + '</div></div>').join('');
    document.getElementById('clouds').innerHTML = (s.clouds.length ? s.clouds : []).map((c) =>
      '<div class="cloud"><div><b>' + esc(c.label) + '</b><small>' + esc(c.detail)
      + (c.latencyMs != null ? ' · ' + c.latencyMs + ' ms' : '') + '</small></div>'
      + (c.status === 'connected' ? '<span class="pill ok">connected</span>'
        : c.status === 'configured' ? '<span class="pill cfg">configured</span>'
        : c.status === 'not-configured' ? '<span class="pill off">not configured</span>'
        : '<span class="pill bad">unreachable</span>') + '</div>').join('')
      || '<div class="muted">checking…</div>';
    const m = Object.entries(s.mirrorCounts).sort((a, b) => b[1] - a[1]);
    document.getElementById('mirror').innerHTML = m.length
      ? '<tr><th>Entity</th><th>Rows</th></tr>' + m.map(([k, v]) => '<tr><td>' + esc(k) + '</td><td>' + v.toLocaleString() + '</td></tr>').join('')
      : '<tr><td class="muted">waiting for the first sync…</td></tr>';
  } catch {}
}
tick(); setInterval(tick, 4000);
</script>
</body></html>`
}

let dashboardServer: { port: number; url: string } | null = null

function startDashboard(): void {
  for (let port = DASHBOARD_PORT_BASE; port < DASHBOARD_PORT_BASE + 10; port++) {
    try {
      Bun.serve({
        port,
        hostname: '127.0.0.1',
        fetch(req) {
          const url = new URL(req.url)
          if (url.pathname === '/api/state') {
            return new Response(JSON.stringify(state), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
          }
          return new Response(dashboardHtml(), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
        },
      })
      dashboardServer = { port, url: `http://127.0.0.1:${port}` }
      state.dashboardUrl = dashboardServer.url
      return
    } catch {
      /* port busy — try the next one */
    }
  }
  log('dashboard unavailable — ports 9753-9762 all busy', { silent: true })
}

function openBrowser(url: string): void {
  try {
    if (IS_WINDOWS) {
      Bun.spawn(['cmd', '/c', 'start', '', url], { stdout: 'ignore', stderr: 'ignore' })
    } else if (process.platform === 'darwin') {
      Bun.spawn(['open', url], { stdout: 'ignore', stderr: 'ignore' })
    } else {
      Bun.spawn(['xdg-open', url], { stdout: 'ignore', stderr: 'ignore' })
    }
  } catch {
    /* non-fatal */
  }
}

// ─── Windows self-install ────────────────────────────────────────────────────

function run(cmd: string[], opts: { wait?: boolean } = {}): boolean {
  try {
    const proc = Bun.spawn(cmd, { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' })
    if (opts.wait) void proc.exited
    return true
  } catch {
    return false
  }
}

function createShortcut(location: 'Desktop' | 'Programs', target: string): void {
  const script =
    `$ws = New-Object -ComObject WScript.Shell; ` +
    `$s = $ws.CreateShortcut([Environment]::GetFolderPath('${location}') + '\\RSM Cloud Agent.lnk'); ` +
    `$s.TargetPath = '${target}'; $s.Description = 'RSM restaurant platform - cloud sync agent'; $s.Save()`
  run(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { wait: true })
}

function registerAutoStart(target: string): void {
  run(
    ['reg', 'add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'RSMCloudAgent', '/t', 'REG_SZ', '/d', `"${target}"`, '/f'],
    { wait: true },
  )
}

/** Returns true when the agent is already running from the installed location
 *  (or just installed itself and spawned the installed copy). */
function ensureInstalled(): boolean {
  if (!IS_WINDOWS) {
    state.install.installed = true
    return true
  }
  const self = process.execPath
  const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  if (samePath(self, INSTALLED_EXE)) {
    state.install.installed = true
    return true
  }

  console.log(`\n  Installing ${APP_TITLE}…`)
  try {
    mkdirSync(INSTALL_DIR, { recursive: true })
  } catch (err) {
    fatal(`cannot create ${INSTALL_DIR}: ${String(err)}`)
  }

  let alreadyRunning = false
  try {
    // A running exe is locked by Windows — that means an installed copy is
    // live right now. Update the shortcuts anyway and let the running
    // instance keep going.
    copyFileSync(self, INSTALLED_EXE)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
      alreadyRunning = true
    } else {
      fatal(`cannot copy to ${INSTALLED_EXE}: ${String(err)}`)
    }
  }

  createShortcut('Desktop', INSTALLED_EXE)
  createShortcut('Programs', INSTALLED_EXE)
  registerAutoStart(INSTALLED_EXE)
  state.install.autoStart = true

  if (alreadyRunning) {
    console.log('  ✓ Already installed — an agent is running on this PC (nothing else to do).')
    console.log('  ✓ This installer window will close; the running agent keeps syncing.\n')
    sleep(2500).then(() => process.exit(0))
    return false
  }

  console.log(`  ✓ Installed to ${INSTALLED_EXE}`)
  console.log('  ✓ Desktop + Start Menu shortcuts created')
  console.log('  ✓ Auto-start with Windows registered (current user)')
  console.log('  ✓ Starting the agent…\n')
  try {
    Bun.spawn([INSTALLED_EXE], { detached: true, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' })
  } catch (err) {
    fatal(`failed to start the installed agent: ${String(err)}`)
  }
  sleep(1500).then(() => process.exit(0))
  return false
}

// ─── console interaction ─────────────────────────────────────────────────────

function startConsoleCommands(): void {
  if (!process.stdin.isTTY) return
  try {
    process.stdin.setRawMode?.(true)
  } catch {
    /* best effort */
  }
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => {
    if (chunk === '\u0003') process.exit(0) // Ctrl+C in raw mode
    const key = chunk.trim().toLowerCase()
    if (key === 'q') {
      console.log('\n  stopping…')
      process.exit(0)
    } else if (key === 's') {
      console.log('  → manual sync requested')
      void syncCycle()
    } else if (key === 'o') {
      if (dashboardServer) openBrowser(dashboardServer.url)
    } else if (key === 'b') {
      console.log('  → re-bootstrapping…')
      void bootstrap().catch((err) => log(`bootstrap failed: ${String(err)}`))
    } else if (key === 'c') {
      console.log(`  → current server: ${config.baseUrl}`)
      console.log('    edit "baseUrl" in config.json (then press s to sync), or restart the agent')
    }
  })
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`
  ┌─────────────────────────────────────────────────────┐
  │        RSM Cloud Agent · وكيل سحابة RSM             │
  │   Windows 10 companion — two-way cloud sync         │
  └─────────────────────────────────────────────────────┘
  version ${VERSION} · ${state.app.platform}`)

  // 1. install (Windows) — may spawn the installed copy and exit
  if (!ensureInstalled()) return

  // 2. prepare the data directory + outbox folders
  for (const dir of [DATA_DIR, OUTBOX_DIR, OUTBOX_SENT, OUTBOX_DEAD]) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch (err) {
      fatal(`cannot create ${dir}: ${String(err)}`)
    }
  }

  // 3. configuration: embedded download-time config → saved config file
  //
  // HUB-FIRST (v1.1): the durable cloud deployment (Vercel, backed by Neon)
  // is the hub every device exchanges events through. A local/preview origin
  // can enroll + bootstrap an agent, but the origin's OWN POS writes ride its
  // local→cloud outbox (they are never served on its pull stream), so an
  // agent pointed at a local origin would never see the owner's changes.
  // The agent therefore syncs with the cloud hub and keeps the download
  // origin only as a failover.
  const embedded = readEmbeddedConfig()
  loadConfig()
  if (embedded) {
    const hub = embedded.cloudUrl ?? DEFAULT_CLOUD_URL
    config.cloudUrl = hub
    const origin = embedded.baseUrl ?? ''
    if (!config.installedAt) {
      // fresh install: hub primary, origin fallback
      config.primaryUrl = hub
      config.baseUrl = hub
      config.fallbackUrl = origin && origin !== hub ? origin : hub
    } else if (origin && config.baseUrl === origin && hub !== origin) {
      // v1.0 upgrade: the old config pointed at the download origin —
      // migrate to hub-first (a manually customized baseUrl is respected)
      config.primaryUrl = hub
      config.baseUrl = hub
      config.fallbackUrl = origin
    } else if (!config.primaryUrl) {
      config.primaryUrl = config.baseUrl
    }
    if (embedded.enrollKey && !config.enrollKey) config.enrollKey = embedded.enrollKey
    log(
      `download-time config: hub ${hub}` +
        (origin && origin !== hub ? ` (origin fallback ${origin})` : ''),
    )
  } else if (!config.primaryUrl) {
    config.primaryUrl = config.baseUrl
  }
  if (!config.installedAt) {
    config.installedAt = nowIso()
  }
  saveConfig()
  state.server.baseUrl = config.baseUrl
  state.server.cloudUrl = config.cloudUrl
  state.install.installed = true

  // 4. restore the local mirror (if any) and show where things live
  loadMirror()
  refreshMirrorCounts()
  console.log(`
  data     ${DATA_DIR}
  outbox   ${OUTBOX_DIR}
  server   ${config.baseUrl}${config.baseUrl !== config.fallbackUrl ? ` (fallback ${config.fallbackUrl})` : ''}
  mirror   ${state.mirrorTotal.toLocaleString()} rows restored
  commands s = sync now · o = open dashboard · b = re-bootstrap · q = quit
`)

  // 5. dashboard first (ready to work right away), then the sync loop
  startDashboard()
  if (dashboardServer) {
    console.log(`  dashboard ${dashboardServer.url}  (opens in your browser on first sync)`)
  }
  startConsoleCommands()

  const firstRun = state.mirrorTotal === 0
  await syncCycle()
  if (firstRun && dashboardServer) openBrowser(dashboardServer.url)

  // main loop: catch-up pace while a backlog remains, steady 30s afterwards
  for (;;) {
    const backlog = state.sync.remaining > 0 || state.sync.pendingOutbox > 0
    await sleep(backlog ? CATCHUP_INTERVAL_MS : SYNC_INTERVAL_MS)
    await syncCycle()
  }
}

void main().catch((err) => fatal(String(err)))

process.on('SIGINT', () => {
  console.log('\n  stopping…')
  saveConfig()
  if (mirrorDirty) saveMirror()
  process.exit(0)
})
process.on('SIGTERM', () => process.exit(0))
