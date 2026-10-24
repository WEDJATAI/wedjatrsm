/**
 * RSM Platform supervisor — r43: the FULL desktop version.
 * ────────────────────────────────────────────────────────────────────────────
 * When the compiled agent carries an embedded platform payload (baked after
 * the executable bytes by build-windows.sh — [exe][zip][u64 len][RSMPKG1END]),
 * the agent stops being a thin mirror companion and becomes the platform's
 * installer + supervisor:
 *
 *   1. EXTRACT   the embedded payload (the complete app: src/, prisma/,
 *                public/, configs, db/, windows/ launcher scripts,
 *                desktop-setup.mjs, agent-assets/platform.ico)
 *   2. RUNTIME   detect bun or node on the PC; download the official
 *                bun-windows-x64.zip when neither exists (the agent's own
 *                embedded runtime cannot run `bun install` — programmatic
 *                package install is not part of compiled binaries)
 *   3. INSTALL   `bun/node install` + `prisma generate` (one-time, online)
 *   4. ENROLL    POST /api/hybrid/device/self with the embedded enrollment
 *                key → the cloud registers the device and hands back its
 *                credentials (deviceId + deviceKey, shown exactly once)
 *   5. PROVISION desktop-setup.mjs writes the identity + target into the
 *                installed app's database, pulls the cloud's bootstrap
 *                snapshot (all business tables) and parks the pull cursor
 *                at the stream head — two-way sync starts LIVE
 *   6. BUILD     `next build` once (production mode); a build failure falls
 *                back to `next dev` transparently
 *   7. RUN + WATCH  `next start/dev -p 3000..3020` as a supervised child:
 *                crash/hang → automatic restart; the dashboard at
 *                127.0.0.1:9753 shows the platform status + the LIVE
 *                two-way sync health (the same /api/hybrid/live-health the
 *                cloud version's Launcher pill shows)
 *
 * Without a payload every function here is a no-op — the agent keeps its
 * r32/r36 companion behavior unchanged.
 *
 * r58: the payload rides TWO ways — appended after the executable bytes on
 * Windows (PE-overlay tail) or as a bundle RESOURCE beside the executable
 * (macOS .app / bare-binary neighbour), because the Mach-O code signature
 * must remain the last thing in the binary.
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, hostname, platform as osPlatform } from 'node:os'
import { dirname, join } from 'node:path'

// ─── constants ───────────────────────────────────────────────────────────────

const IS_WINDOWS = process.platform === 'win32'
const IS_MACOS = process.platform === 'darwin'

/** Trailing marker of the baked payload block: [zip][u64 LE len][marker]. */
const PKG_MARKER = 'RSMPKG1END'
const PKG_MARKER_LEN = PKG_MARKER.length
const PKG_LEN_LEN = 8
/** The payload can be several MB — scan back this far for the marker. */
const PKG_SCAN_WINDOW = 48 * 1024 * 1024

const PLATFORM_VERSION = '2.1.0'

/** Where the full platform lives. Windows: %LOCALAPPDATA%\RSMPlatform,
 *  macOS/Linux: ~/.rsm-platform (r58: the universal macOS installer carries
 *  the same full payload — macOS is a first-class desktop platform now, not
 *  just a testing/parity target). */
export const PLATFORM_ROOT = IS_WINDOWS
  ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'RSMPlatform')
  : join(homedir(), '.rsm-platform')

export const PLATFORM_DIR = join(PLATFORM_ROOT, 'platform')
const RUNTIME_DIR = join(PLATFORM_ROOT, 'runtime')
const PLATFORM_LOG = join(PLATFORM_ROOT, 'platform.log')
const SERVER_LOG = join(PLATFORM_ROOT, 'server.log')
const PROVISIONED_MARKER = join(PLATFORM_DIR, 'db', 'desktop-provisioned.json')
const ICO_PATH = join(PLATFORM_ROOT, 'platform.ico')

/** First port tried for the platform server (matches the README + the
 *  .env-free `next start -p` convention). Overridable for tests. */
const PORT_BASE = Number(process.env.RSM_PLATFORM_PORT ?? 3000)
const PORT_TRIES = 21 // 3000..3020
const PORT_BASE_DASHBOARD = 9753 // agent's own dashboard (main.ts owns it)

const INSTALL_TIMEOUT_MS = 15 * 60_000
const GENERATE_TIMEOUT_MS = 5 * 60_000
const BUILD_TIMEOUT_MS = 15 * 60_000
const READY_TIMEOUT_PROD_MS = 120_000
const READY_TIMEOUT_DEV_MS = 10 * 60_000
const HEALTH_POLL_MS = 15_000
const MONITOR_TICK_MS = 5_000
const RESTART_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000]

/** r58: official, stable download URLs for the Bun runtime — one per
 *  platform+arch (Windows x64, macOS universal-installer slices, Linux for
 *  CI/E2E parity). Keyed by `<platform>-<arch>` with win32 → windows. */
const RUNTIME_KEY = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`
const BUN_RUNTIME_URL: Record<string, string> = {
  'windows-x64': 'https://github.com/oven-sh/bun/releases/latest/download/bun-windows-x64.zip',
  'darwin-x64': 'https://github.com/oven-sh/bun/releases/latest/download/bun-darwin-x64.zip',
  'darwin-arm64': 'https://github.com/oven-sh/bun/releases/latest/download/bun-darwin-arm64.zip',
  'linux-x64': 'https://github.com/oven-sh/bun/releases/latest/download/bun-linux-x64.zip',
  'linux-arm64': 'https://github.com/oven-sh/bun/releases/latest/download/bun-linux-arm64.zip',
}
const RUNTIME_BIN = process.platform === 'win32' ? 'bun.exe' : 'bun'

const nowIso = () => new Date().toISOString()

// ─── shared state (rendered by main.ts's dashboard) ──────────────────────────

export type PlatformSyncHealth = {
  checkedAt: string | null
  healthy: boolean | null
  engine: string | null
  paused: boolean | null
  cloudReachable: string | null
  lastPushAt: string | null
  lastPullAt: string | null
  pendingUploads: number | null
  pendingDownloads: number | null
  deviceName: string | null
  error: string | null
}

export type PlatformState = {
  available: boolean // payload embedded in this binary?
  version: string
  rootDir: string
  platformDir: string
  status: 'not-installed' | 'installing' | 'starting' | 'running' | 'stopped' | 'error'
  step: string // human-readable current install step
  progress: number // 0..100 across the install steps
  url: string | null
  port: number | null
  mode: 'production' | 'dev' | null
  runtime: 'bun' | 'node' | null
  runtimeDownloaded: boolean
  provisioned: boolean
  enrolled: boolean
  deviceId: string | null
  lastError: string | null
  startedAt: string | null
  restarts: number
  sync: PlatformSyncHealth
}

export const platformState: PlatformState = {
  available: false,
  version: PLATFORM_VERSION,
  rootDir: PLATFORM_ROOT,
  platformDir: PLATFORM_DIR,
  status: 'not-installed',
  step: '',
  progress: 0,
  url: null,
  port: null,
  mode: null,
  runtime: null,
  runtimeDownloaded: false,
  provisioned: false,
  enrolled: false,
  deviceId: null,
  lastError: null,
  startedAt: null,
  restarts: 0,
  sync: {
    checkedAt: null,
    healthy: null,
    engine: null,
    paused: null,
    cloudReachable: null,
    lastPushAt: null,
    lastPullAt: null,
    pendingUploads: null,
    pendingDownloads: null,
    deviceName: null,
    error: null,
  },
}

// The agent config written by main.ts (set from there once loaded).
export type PlatformConfig = {
  cloudUrl: string
  enrollKey: string
  deviceId?: string
  deviceKey?: string
  enrolledAt?: string
}
let cfg: PlatformConfig | null = null
export function setPlatformConfig(c: PlatformConfig): void {
  cfg = c
}
export function getPlatformConfig(): PlatformConfig | null {
  return cfg
}

// ─── logging ─────────────────────────────────────────────────────────────────

function plog(msg: string): void {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`
  console.log(`  [platform] ${msg}`)
  try {
    appendFileSync(PLATFORM_LOG, `${line}\n`)
  } catch {
    /* read-only dir — console only */
  }
}

function setStep(step: string, progress: number): void {
  platformState.step = step
  platformState.progress = progress
  plog(step)
}

// ─── embedded payload (the baked platform ZIP) ───────────────────────────────

export type EmbeddedPayload = { size: number }

/** Side-car payload candidates (r58): the macOS universal installer carries
 *  the platform ZIP as a bundle RESOURCE — the Mach-O code signature must
 *  remain the last thing in the binary, so the Windows PE-overlay tail is
 *  not used there. A bare-executable neighbour (dev/E2E runs) also works. */
function payloadSidecarPaths(): string[] {
  const exeDir = dirname(process.execPath)
  const candidates = [
    join(exeDir, '..', 'Resources', 'platform-payload.zip'), // inside a .app bundle
    join(exeDir, 'platform-payload.zip'), // beside a bare executable (dev/E2E)
  ]
  try {
    // dev-time (`bun agent-desktop/main.ts`): the staged payload in dist/
    const here = new URL('.', import.meta.url).pathname
    candidates.push(join(here, 'dist', 'rsm-platform-payload.zip'))
  } catch {
    /* compiled binary — virtual URL, skip this candidate */
  }
  return candidates
}

/** A readable, zip-magic-validated payload side-car path, or null. */
function findPayloadSidecar(): string | null {
  for (const p of payloadSidecarPaths()) {
    try {
      if (!existsSync(p)) continue
      const fd = openSync(p, 'r')
      try {
        const magic = Buffer.alloc(2)
        readSync(fd, magic, 0, 2, 0)
        if (magic[0] === 0x50 && magic[1] === 0x4b) return p
      } finally {
        closeSync(fd)
      }
    } catch {
      /* next candidate */
    }
  }
  return null
}

/** Is a platform payload baked into this executable (tail) or riding
 *  beside it (macOS .app resource / bare-binary neighbour)? */
export function hasEmbeddedPayload(): boolean {
  return findPayload() !== null || findPayloadSidecar() !== null
}

/** Locate the payload block inside our own executable bytes.
 *  Layout: [exe][zip bytes][u64 LE zip length][RSMPKG1END][optional RSMCFG1 tail]
 *  The scan starts at the END (the RSMCFG1 config tail appended at download
 *  time sits after the marker) and walks back; every candidate is VALIDATED
 *  (length bounds + the zip's PK magic read straight from the file) so a
 *  random byte pattern can never fool the reader. */
function findPayload(): { start: number; size: number } | null {
  try {
    const fd = openSync(process.execPath, 'r')
    try {
      const fileSize = fstatSync(fd).size
      const windowSize = Math.min(PKG_SCAN_WINDOW, fileSize)
      const windowBase = fileSize - windowSize // buffer positions are relative to this
      const buf = Buffer.alloc(windowSize)
      readSync(fd, buf, 0, windowSize, windowBase)
      let idx = buf.lastIndexOf(PKG_MARKER)
      while (idx >= 0) {
        const lenOff = idx - PKG_LEN_LEN
        if (lenOff >= 0) {
          const size = Number(buf.readBigUInt64LE(lenOff))
          const start = windowBase + lenOff - size // absolute file offset
          if (Number.isInteger(size) && size > 4 && start >= 0 && start + size <= fileSize) {
            const magic = Buffer.alloc(4)
            readSync(fd, magic, 0, 4, start)
            if (magic[0] === 0x50 && magic[1] === 0x4b) {
              return { start, size }
            }
          }
        }
        idx = buf.lastIndexOf(PKG_MARKER, idx - 1)
      }
      return null
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

/** Extract the embedded payload zip into a temp file — from the PE-overlay
 *  tail (Windows) or by copying the side-car resource (macOS .app / dev). */
function writePayloadToTemp(): string | null {
  const tmpZip = join(PLATFORM_ROOT, 'payload.zip')
  const found = findPayload()
  if (found) {
    mkdirSync(PLATFORM_ROOT, { recursive: true })
    const fd = openSync(process.execPath, 'r')
    try {
      const out = Buffer.alloc(found.size)
      readSync(fd, out, 0, found.size, found.start)
      writeFileSync(tmpZip, out)
      return tmpZip
    } catch {
      return null
    } finally {
      closeSync(fd)
    }
  }
  const sidecar = findPayloadSidecar()
  if (sidecar) {
    try {
      mkdirSync(PLATFORM_ROOT, { recursive: true })
      copyFileSync(sidecar, tmpZip)
      return tmpZip
    } catch {
      return null
    }
  }
  return null
}

/** Extract a zip archive. Windows 10+ and macOS ship bsdtar (zip-capable);
 *  Linux ships GNU tar (zip-INCAPABLE) so `unzip` is tried there first.
 *  One of the two exists on virtually every machine we support. */
async function extractZip(zipPath: string, destDir: string): Promise<boolean> {
  mkdirSync(destDir, { recursive: true })
  const attempts: Array<{ cmd: string[]; label: string }> = [
    { cmd: ['tar', '-xf', zipPath, '-C', destDir], label: 'tar' },
    { cmd: ['unzip', '-o', '-q', zipPath, '-d', destDir], label: 'unzip' },
  ]
  // on Linux prefer unzip (GNU tar cannot read zips); elsewhere bsdtar first
  if (!IS_WINDOWS && !IS_MACOS) attempts.reverse()
  for (const attempt of attempts) {
    const proc = Bun.spawn(attempt.cmd, { stdout: 'ignore', stderr: 'pipe' })
    void new Response(proc.stderr).text().then((errText) => {
      if (errText.trim()) plog(`${attempt.label}: ${errText.trim().slice(0, 160)}`)
    })
    // Bun.spawn's exitCode is null until exit — await the exit promise
    const code = await proc.exited
    if (code === 0) return true
    plog(`${attempt.label} extraction failed (exit ${code}) — trying the next extractor`)
  }
  return false
}

/** Extract the embedded payload. Returns true when the platform tree is
 *  present afterwards. */
export async function extractPayload(force = false): Promise<boolean> {
  const marker = join(PLATFORM_DIR, 'package.json')
  if (!force && existsSync(marker)) {
    platformState.provisioned = existsSync(PROVISIONED_MARKER)
    return true
  }
  const zip = writePayloadToTemp()
  if (!zip) {
    platformState.lastError = 'no payload embedded in this executable'
    return false
  }
  try {
    mkdirSync(PLATFORM_ROOT, { recursive: true })
    rmSync(PLATFORM_DIR, { recursive: true, force: true })
    const ok = await extractZip(zip, PLATFORM_DIR)
    if (!ok) {
      platformState.lastError = 'payload extraction failed'
      return false
    }
    // the desktop icon asset rides inside the payload — hoist it next to
    // the exe so the shortcut's IconLocation is stable
    const ico = join(PLATFORM_DIR, 'agent-assets', 'platform.ico')
    if (existsSync(ico)) {
      try {
        copyFileSync(ico, ICO_PATH)
      } catch {
        /* cosmetic only */
      }
    }
    platformState.provisioned = existsSync(PROVISIONED_MARKER)
    plog(`payload extracted → ${PLATFORM_DIR}`)
    return true
  } finally {
    rmSync(zip, { force: true })
  }
}

// ─── r58 FIX: absolute DATABASE_URL in the installed platform ────────────

/** The payload's relative `file:./db/custom.db` (historically
 *  `file:../db/custom.db`) is CWD-relative for the libsql runtime adapter
 *  and SCHEMA-relative for the Prisma CLI — under `next start` the app
 *  resolved it against the process cwd and failed with SQLITE_CANTOPEN (14):
 *  the installed platform could never boot in production mode. The agent
 *  rewrites the installed .env to the ABSOLUTE db path (unambiguous for the
 *  runtime, dev, production and the CLI alike). Idempotent, runs on every
 *  agent start — so existing installs are upgraded too. */
export function ensureAbsoluteDbUrl(): void {
  const envPath = join(PLATFORM_DIR, '.env')
  const dbAbs = join(PLATFORM_DIR, 'db', 'custom.db').replaceAll('\\', '/')
  const absUrl = `file:${dbAbs}`
  try {
    let raw = ''
    try {
      raw = readFileSync(envPath, 'utf8')
    } catch {
      /* no .env yet — create it */
    }
    if (raw.includes(`DATABASE_URL=${absUrl}`)) return // already absolute + current
    const line = raw.match(/^DATABASE_URL=.*$/m)
    if (line) raw = raw.replace(line[0], `DATABASE_URL=${absUrl}`)
    else raw = `${raw.trimEnd()}\nDATABASE_URL=${absUrl}\n`
    writeFileSync(envPath, raw)
    plog(`DATABASE_URL normalized to the absolute db path (${absUrl})`)
  } catch (err) {
    plog(`db url normalization failed (non-fatal): ${String(err)}`)
  }
}

// ─── runtime resolution (bun / node / downloaded bun) ───────────────────────

export type Runtime = { kind: 'bun' | 'node'; exe: string; downloaded: boolean }

/** `where`/`which` probe for a runtime on PATH. */
function probePath(exe: string): string | null {
  const cmd = IS_WINDOWS ? ['where', exe] : ['which', exe]
  try {
    const proc = Bun.spawnSync(cmd, { stdout: 'pipe', stderr: 'ignore' })
    const out = new TextDecoder().decode(proc.stdout).trim()
    if (proc.exitCode === 0 && out) return out.split(/\r?\n/)[0]
  } catch {
    /* not found */
  }
  return null
}

/** Look for bun/node on the PC, then at the previously downloaded runtime. */
export function detectRuntime(): Runtime | null {
  // previously downloaded bun?
  const localBun = join(RUNTIME_DIR, RUNTIME_BIN)
  if (existsSync(localBun)) {
    platformState.runtimeDownloaded = true
    return { kind: 'bun', exe: localBun, downloaded: true }
  }
  const bun = probePath('bun')
  if (bun) return { kind: 'bun', exe: bun, downloaded: false }
  const node = probePath('node')
  if (node) return { kind: 'node', exe: node, downloaded: false }
  return null
}

/** Download the official Bun runtime into RUNTIME_DIR (every supported
 *  platform — r58: macOS/Linux no longer require a manual runtime install). */
async function downloadRuntime(): Promise<Runtime | null> {
  const url = BUN_RUNTIME_URL[RUNTIME_KEY]
  if (!url) {
    plog(`no runtime download for ${RUNTIME_KEY} — install Bun (bun.com) or Node.js 20+ manually`)
    return null
  }
  setStep('Downloading the Bun runtime (one-time, ~90 MB)…', 25)
  mkdirSync(RUNTIME_DIR, { recursive: true })
  const zipName = `bun-${RUNTIME_KEY}.zip`
  const zipPath = join(RUNTIME_DIR, zipName)
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    writeFileSync(zipPath, bytes)
    const ok = await extractZip(zipPath, RUNTIME_DIR)
    rmSync(zipPath, { force: true })
    if (!ok) throw new Error('extraction failed')
    // the zip contains bun-<platform>-<arch>/bun[.exe]
    const nested = join(RUNTIME_DIR, `bun-${RUNTIME_KEY}`, RUNTIME_BIN)
    const flat = join(RUNTIME_DIR, RUNTIME_BIN)
    if (existsSync(nested)) {
      copyFileSync(nested, flat)
      if (process.platform !== 'win32') chmodSync(flat, 0o755)
    }
    if (!existsSync(flat)) throw new Error(`${RUNTIME_BIN} not found after extraction`)
    platformState.runtimeDownloaded = true
    plog(`bun runtime downloaded (${(bytes.length / 1024 / 1024).toFixed(1)} MB) for ${RUNTIME_KEY}`)
    return { kind: 'bun', exe: flat, downloaded: true }
  } catch (err) {
    plog(`runtime download failed: ${String(err)}`)
    return null
  }
}

// ─── subprocess helpers ──────────────────────────────────────────────────────

/** Child env for platform processes: the ambient environment MINUS any
 *  DATABASE_URL — the platform's own .env (file:../db/custom.db) must always
 *  govern, or a stray exported var would silently redirect the platform
 *  (and its sync engine) to a foreign database. */
function platformEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, FORCE_COLOR: '0', NEXT_TELEMETRY_DISABLED: '1' }
  delete env.DATABASE_URL
  return env
}

function spawnLogged(cmd: string[], opts: { cwd: string; timeoutMs: number; logPrefix: string }): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const proc = Bun.spawn(cmd, {
        cwd: opts.cwd,
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
        env: platformEnv(),
      })
      const timer = setTimeout(() => {
        try {
          proc.kill()
        } catch {
          /* already gone */
        }
      }, opts.timeoutMs)
      const pump = (stream: ReadableStream<Uint8Array> | undefined, tag: string) => {
        if (!stream) return Promise.resolve()
        return new Response(stream)
          .text()
          .then((text) => {
            for (const line of text.split(/\r?\n/)) {
              if (line.trim()) {
                try {
                  appendFileSync(PLATFORM_LOG, `[${opts.logPrefix}:${tag}] ${line.slice(0, 400)}\n`)
                } catch {
                  /* read-only */
                }
              }
            }
          })
          .catch(() => {})
      }
      // streams can close slightly BEFORE the exit code is finalized — the
      // authoritative result is the exited promise (proc.exitCode may still
      // be null at pump-completion time, which once misreported a successful
      // prisma generate as failed).
      void Promise.all([pump(proc.stdout, 'out'), pump(proc.stderr, 'err')]).then(async () => {
        clearTimeout(timer)
        resolve((await proc.exited) === 0)
      })
    } catch (err) {
      plog(`spawn failed (${cmd.join(' ')}): ${String(err)}`)
      resolve(false)
    }
  })
}

// ─── platform install steps ──────────────────────────────────────────────────

async function installDependencies(rt: Runtime, force = false): Promise<boolean> {
  if (!force && existsSync(join(PLATFORM_DIR, 'node_modules', '.bin'))) {
    plog('dependencies already installed')
    return true
  }
  if (rt.kind === 'bun') {
    setStep('Installing dependencies (bun install — usually 1-3 minutes)…', 40)
    return spawnLogged([rt.exe, 'install'], {
      cwd: PLATFORM_DIR,
      timeoutMs: INSTALL_TIMEOUT_MS,
      logPrefix: 'install',
    })
  }
  // node → npm lives beside the binary (npm.cmd on Windows); fall back to
  // an npm found on PATH. Invoked directly — never through npx.
  const besideNpm = IS_WINDOWS ? join(dirname(rt.exe), 'npm.cmd') : join(dirname(rt.exe), 'npm')
  const npm = existsSync(besideNpm) ? besideNpm : probePath(IS_WINDOWS ? 'npm.cmd' : 'npm')
  if (!npm) {
    plog('npm not found beside node or on PATH')
    return false
  }
  setStep('Installing dependencies (npm install — usually 3-10 minutes)…', 40)
  return spawnLogged([npm, 'install', '--no-audit', '--no-fund'], {
    cwd: PLATFORM_DIR,
    timeoutMs: INSTALL_TIMEOUT_MS,
    logPrefix: 'install',
  })
}

async function prismaGenerate(rt: Runtime): Promise<boolean> {
  setStep('Generating the database client…', 55)
  return spawnLogged([rt.exe, join('node_modules', 'prisma', 'build', 'index.js'), 'generate'], {
    cwd: PLATFORM_DIR,
    timeoutMs: GENERATE_TIMEOUT_MS,
    logPrefix: 'prisma',
  })
}

// ─── cloud enrollment (the platform's own device identity) ──────────────────

/** Enroll THIS PLATFORM as a hybrid device on the cloud hub. Credentials are
 *  persisted by main.ts (config.json) and injected into the platform DB by
 *  desktop-setup.mjs — the same credentials authenticate the agent's
 *  live-health polls against BOTH the local platform and the cloud. */
export async function enrollPlatformDevice(): Promise<{ deviceId: string; deviceKey: string } | null> {
  if (!cfg) return null
  if (cfg.deviceId && cfg.deviceKey) {
    platformState.enrolled = true
    platformState.deviceId = cfg.deviceId
    return { deviceId: cfg.deviceId, deviceKey: cfg.deviceKey }
  }
  if (!cfg.enrollKey) {
    plog('cannot enroll: no enrollment key embedded')
    return null
  }
  try {
    const res = await fetch(`${cfg.cloudUrl.replace(/\/+$/, '')}/api/hybrid/device/self`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: `${hostname()} · RSM Desktop`,
        platform: IS_WINDOWS ? 'windows' : IS_MACOS ? 'mac' : 'linux',
        enrollKey: cfg.enrollKey,
      }),
      signal: AbortSignal.timeout(30_000),
    })
    const data = (await res.json().catch(() => ({}))) as { deviceId?: string; deviceKey?: string; error?: string }
    if (!res.ok || !data.deviceId || !data.deviceKey) {
      throw new Error(data.error ?? `HTTP ${res.status}`)
    }
    cfg.deviceId = data.deviceId
    cfg.deviceKey = data.deviceKey
    cfg.enrolledAt = nowIso()
    platformState.enrolled = true
    platformState.deviceId = data.deviceId
    plog(`platform enrolled as hybrid device ${data.deviceId.slice(0, 8)}…`)
    return { deviceId: data.deviceId, deviceKey: data.deviceKey }
  } catch (err) {
    plog(`enrollment failed: ${String(err)}`)
    return null
  }
}

// ─── provisioning (desktop-setup.mjs) ────────────────────────────────────────

/** Run the payload's provision script: identity + target + cloud bootstrap. */
export async function provisionPlatform(rt: Runtime, force = false): Promise<boolean> {
  if (!cfg) return false
  if (!force && existsSync(PROVISIONED_MARKER)) {
    platformState.provisioned = true
    return true
  }
  const creds = await enrollPlatformDevice()
  if (!creds) return false
  setStep(force ? 'Re-syncing from the cloud…' : 'Provisioning from the cloud (first-time data sync)…', 65)
  if (force) {
    try {
      rmSync(PROVISIONED_MARKER, { force: true })
    } catch {
      /* fine */
    }
  }
  const ok = await spawnLogged(
    [
      rt.exe,
      'desktop-setup.mjs',
      '--target', cfg.cloudUrl,
      '--device-id', creds.deviceId,
      '--device-key', creds.deviceKey,
      '--device-name', `${hostname()} · RSM Desktop`,
    ],
    { cwd: PLATFORM_DIR, timeoutMs: 10 * 60_000, logPrefix: 'setup' },
  )
  platformState.provisioned = existsSync(PROVISIONED_MARKER)
  if (ok && platformState.provisioned) {
    plog('platform provisioned — two-way sync armed')
    return true
  }
  platformState.lastError = 'provisioning failed (see platform.log) — retry from the dashboard'
  return false
}

// ─── production build ────────────────────────────────────────────────────────

/** One-time `next build`. Failure is NOT fatal — the supervisor falls back
 *  to dev mode (slower first loads, same functionality). RSM_PLATFORM_SKIP_BUILD=1
 *  skips the build entirely (testing + very weak PCs). */
async function buildProduction(rt: Runtime): Promise<boolean> {
  if (existsSync(join(PLATFORM_DIR, '.next', 'BUILD_ID'))) return true
  if (process.env.RSM_PLATFORM_SKIP_BUILD === '1') {
    plog('production build skipped (RSM_PLATFORM_SKIP_BUILD=1) — dev mode')
    return false
  }
  setStep('Building the production app (one-time, a few minutes)…', 78)
  const ok = await spawnLogged(
    [rt.exe, join('node_modules', 'next', 'dist', 'bin', 'next'), 'build'],
    { cwd: PLATFORM_DIR, timeoutMs: BUILD_TIMEOUT_MS, logPrefix: 'build' },
  )
  if (!ok) {
    plog('production build failed — falling back to dev mode')
    try {
      rmSync(join(PLATFORM_DIR, '.next'), { recursive: true, force: true })
    } catch {
      /* keep whatever is there */
    }
  }
  return existsSync(join(PLATFORM_DIR, '.next', 'BUILD_ID'))
}

// ─── the supervised server ───────────────────────────────────────────────────

type ServerProc = {
  proc: ReturnType<typeof Bun.spawn>
  port: number
  mode: 'production' | 'dev'
  /** resolved to the exit code once the process dies (authoritative —
   * proc.exitCode can lag behind stream closure) */
  exited: Promise<number>
}

let serverProc: ServerProc | null = null
/** exit code of the CURRENT serverProc once it dies (null = alive) — set by
 *  the exited promise attached at spawn time (authoritative). */
let serverExitCode: number | null = null
let monitorStarted = false
let restartIndex = 0

/** Start `next start` (production) or `next dev` on the first free port. */
async function startServer(rt: Runtime): Promise<boolean> {
  const mode: 'production' | 'dev' = existsSync(join(PLATFORM_DIR, '.next', 'BUILD_ID')) ? 'production' : 'dev'
  // first port in 3000..3020 where nothing answers
  let port = 0
  for (let off = 0; off < PORT_TRIES; off++) {
    const candidate = PORT_BASE + off
    try {
      await fetch(`http://127.0.0.1:${candidate}/`, { signal: AbortSignal.timeout(700) })
      /* something answers — port taken, try the next */
    } catch {
      port = candidate
      break
    }
  }
  if (!port) {
    platformState.lastError = `no free port in ${PORT_BASE}..${PORT_BASE + PORT_TRIES - 1}`
    return false
  }
  try {
    rmSync(SERVER_LOG, { force: true })
    const proc = Bun.spawn(
      [rt.exe, join('node_modules', 'next', 'dist', 'bin', 'next'), mode === 'production' ? 'start' : 'dev', '-p', String(port)],
      {
        cwd: PLATFORM_DIR,
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
        env: platformEnv(),
      },
    )
    pumpToLog(proc.stdout, 'server')
    pumpToLog(proc.stderr, 'server')
    serverProc = { proc, port, mode, exited: proc.exited }
    serverExitCode = null
    void proc.exited.then((code) => {
      serverExitCode = code
    })
    platformState.mode = mode
    platformState.port = port
    platformState.url = `http://localhost:${port}`
    platformState.status = 'starting'
    platformState.startedAt = nowIso()
    plog(`server starting (${mode} mode, port ${port})`)
    return true
  } catch (err) {
    platformState.lastError = `failed to start the server: ${String(err)}`
    return false
  }
}

function pumpToLog(stream: ReadableStream<Uint8Array> | undefined, tag: string): void {
  if (!stream) return
  void new Response(stream)
    .text()
    .then((text) => {
      try {
        appendFileSync(SERVER_LOG, `[${tag}] ${text}`)
      } catch {
        /* read-only */
      }
    })
    .catch(() => {})
}

/** Wait until the platform answers HTTP on its port. */
async function waitForReady(): Promise<boolean> {
  if (!platformState.port) return false
  const timeoutMs = platformState.mode === 'production' ? READY_TIMEOUT_PROD_MS : READY_TIMEOUT_DEV_MS
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${platformState.port}/`, { signal: AbortSignal.timeout(2500) })
      if (res.ok || res.status === 307 || res.status === 308) {
        platformState.status = 'running'
        plog(`platform READY at ${platformState.url} (${Math.round((Date.now() - t0) / 1000)}s)`)
        return true
      }
    } catch {
      /* still compiling */
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  platformState.status = 'error'
  platformState.lastError = `server did not become ready within ${Math.round(timeoutMs / 1000)}s (see server.log)`
  return false
}

/** Crash/hang watchdog: restarts the server with backoff. */
function startMonitor(): void {
  if (monitorStarted) return
  monitorStarted = true
  let hangChecks = 0
  setInterval(() => {
    if (!serverProc) return
    if (serverExitCode !== null) {
      platformState.status = 'stopped'
      const waitMs = RESTART_BACKOFF_MS[Math.min(restartIndex, RESTART_BACKOFF_MS.length - 1)]
      restartIndex++
      platformState.restarts++
      plog(`server exited — restarting in ${Math.round(waitMs / 1000)}s (restart #${platformState.restarts})`)
      setTimeout(() => {
        void (async () => {
          const rt = detectRuntime()
          if (rt && (await startServer(rt))) await waitForReady()
        })()
      }, waitMs)
      serverProc = null
      return
    }
    // hang detection: a live process that stopped answering for ~45 s
    void (async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${serverProc.port}/`, { signal: AbortSignal.timeout(2500) })
        if (res.ok) {
          hangChecks = 0
          if (platformState.status === 'starting') platformState.status = 'running'
        }
      } catch {
        hangChecks++
        if (hangChecks >= 9 && platformState.status !== 'starting') {
          plog('server appears hung — killing for a fresh restart')
          hangChecks = 0
          try {
            serverProc.proc.kill()
          } catch {
            /* the monitor's exited branch handles it */
          }
        }
      }
    })()
  }, MONITOR_TICK_MS)
}

// ─── live sync health (the same data the cloud pill shows) ───────────────────

/** Poll the LOCAL platform's /api/hybrid/live-health with the platform's own
 *  device credentials (the setup script registered that identity in the
 *  platform's DB, so requireDevice accepts it). */
export async function pollPlatformSyncHealth(): Promise<void> {
  if (!platformState.port || !cfg?.deviceId || !cfg.deviceKey) return
  try {
    const res = await fetch(`http://127.0.0.1:${platformState.port}/api/hybrid/live-health`, {
      headers: { 'x-hybrid-device': cfg.deviceId, 'x-hybrid-key': cfg.deviceKey },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const s = (await res.json()) as {
      healthy: boolean
      engine: string
      paused: boolean
      cloudReachable: string
      lastPushAt: string | null
      lastPullAt: string | null
      pendingUploads: number
      pendingDownloads: number
      deviceName: string | null
    }
    platformState.sync = {
      checkedAt: nowIso(),
      healthy: s.healthy,
      engine: s.engine,
      paused: s.paused,
      cloudReachable: s.cloudReachable,
      lastPushAt: s.lastPushAt,
      lastPullAt: s.lastPullAt,
      pendingUploads: s.pendingUploads,
      pendingDownloads: s.pendingDownloads,
      deviceName: s.deviceName,
      error: null,
    }
  } catch (err) {
    platformState.sync.error = String(err)
    platformState.sync.checkedAt = nowIso()
  }
}

// ─── the orchestrator ────────────────────────────────────────────────────────

/** Full install + provision + start. Safe to call repeatedly (every step is
 *  idempotent). Called at agent start and by the dashboard's restart. */
export async function ensurePlatform(): Promise<boolean> {
  if (!platformState.available) return false
  platformState.status = platformState.status === 'running' ? 'running' : 'installing'

  // 1. payload
  if (!(await extractPayload())) {
    platformState.status = 'error'
    return false
  }

  // 1b. r58: the installed .env must carry the ABSOLUTE db path (the
  // relative payload URL breaks `next start` — SQLITE_CANTOPEN)
  ensureAbsoluteDbUrl()

  // 2. runtime
  setStep('Preparing the runtime…', 30)
  let rt = detectRuntime()
  if (!rt) {
    rt = await downloadRuntime()
    if (!rt) {
      platformState.status = 'error'
      platformState.lastError =
        'No Bun or Node.js on this PC and the runtime download failed. Install Bun (bun.com) or Node.js 20+ (nodejs.org), then double-click the desktop icon again.'
      plog(platformState.lastError)
      return false
    }
  }
  platformState.runtime = rt.kind
  platformState.runtimeDownloaded = rt.downloaded

  // 3. dependencies
  if (!(await installDependencies(rt))) {
    platformState.status = 'error'
    platformState.lastError = 'dependency installation failed — see platform.log (antivirus or proxy interference?)'
    return false
  }

  // 4. prisma client
  if (!(await prismaGenerate(rt))) {
    platformState.status = 'error'
    platformState.lastError = 'prisma generate failed — see platform.log'
    return false
  }

  // 5. enroll + provision (needs the cloud — retried on every agent start)
  if (!(await provisionPlatform(rt))) {
    // NOT fatal: the platform can run offline; sync arms when reachable.
    plog('provisioning pending — the platform starts anyway and retries on the next launch')
  }

  // 6. production build (best-effort)
  await buildProduction(rt)

  // 7. start + watch
  setStep('Starting the platform…', 92)
  if (!(await startServer(rt))) {
    platformState.status = 'error'
    return false
  }
  const ready = await waitForReady()
  if (ready) {
    platformState.status = 'running'
    platformState.step = ''
    platformState.progress = 100
  }
  startMonitor()
  void pollPlatformSyncHealth()
  return ready
}

/** Dashboard action: kill + restart the platform server now. */
export async function restartPlatform(): Promise<boolean> {
  if (serverProc) {
    try {
      serverProc.proc.kill()
    } catch {
      /* already gone */
    }
    serverProc = null
  }
  const rt = detectRuntime()
  if (!rt) {
    platformState.lastError = 'no runtime found'
    return false
  }
  platformState.status = 'starting'
  const ok = await startServer(rt)
  if (ok) await waitForReady()
  // r49: waitForReady() can flip the status to 'running' — read through a
  // widened local so TS doesn't narrow to the literal 'starting' assigned above.
  const st: string = platformState.status
  return ok && st === 'running'
}

/** r58: stop the supervised server + mark stopped (clean agent exit — used
 *  by the dashboard's “Stop agent” button so a new installer version can
 *  replace the running agent in place). */
export function stopPlatform(): void {
  if (serverProc) {
    try {
      serverProc.proc.kill()
    } catch {
      /* already gone */
    }
    serverProc = null
  }
  platformState.status = 'stopped'
  plog('platform server stopped (agent stop)')
}

/** Dashboard action: re-run desktop-setup.mjs (fresh cloud bootstrap). */
export async function resyncPlatform(): Promise<boolean> {
  const rt = detectRuntime()
  if (!rt) return false
  const ok = await provisionPlatform(rt, true)
  if (ok) await restartPlatform()
  return ok
}

// ─── r68: IN-PLACE app updates (new code without re-downloading) ────────────

/** The version of the app payload currently installed (payload-version.json
 * inside the platform dir — stamped by the package builder). Null when the
 * payload predates r68 (treat as "anything published is newer"). */
export function installedAppVersion(): string | null {
  try {
    const raw = readFileSync(join(PLATFORM_DIR, 'payload-version.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version?: string }
    return typeof parsed.version === 'string' ? parsed.version : null
  } catch {
    return null
  }
}

/** True when `remote` is a strictly newer dotted version than `local`
 * (missing/invalid local = everything is newer; missing remote = never). */
export function versionNewer(remote: string | null | undefined, local: string | null): boolean {
  if (!remote) return false
  const parse = (s: string | null): [number, number, number] =>
    s ? ((s.match(/v?(\d+)\.(\d+)\.(\d+)/) ?? []).slice(1).map(Number) as [number, number, number]) : [0, 0, 0]
  const [r1, r2, r3] = parse(remote)
  const [l1, l2, l3] = parse(local)
  if (r1 !== l1) return r1 > l1
  if (r2 !== l2) return r2 > l2
  return r3 > l3
}

export type AppUpdateManifest = {
  available: boolean
  version: string | null
  sha256: string | null
  size: number | null
  url: string | null
  note?: string
}

export type AppUpdateState = {
  checking: boolean
  lastCheckAt: string | null
  lastResult: string | null
  installedVersion: string | null
}

export const appUpdateState: AppUpdateState = {
  checking: false,
  lastCheckAt: null,
  lastResult: null,
  installedVersion: null,
}

/** Top-level entries of the payload zip that must NEVER overlay an installed
 * platform: the live database (business data + hybrid state), the .env
 * (per-install JWT secret + absolute db URL + identity), node_modules (the
 * payload never ships it) and build artifacts. Everything else (src/, prisma/,
 * public/, configs, scripts) overlays the install in place. */
const UPDATE_PRESERVE_TOP = new Set(['db', '.env', 'node_modules', '.next', 'out', 'payload.zip', 'update-staging'])

function overlayTree(src: string, dest: string): void {
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    if (UPDATE_PRESERVE_TOP.has(entry.name)) continue
    const s = join(src, entry.name)
    const d = join(dest, entry.name)
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* replacing below regardless */
    }
    cpSync(s, d, { recursive: true, force: true })
  }
}

/**
 * Apply a downloaded payload zip OVER the installed platform in place:
 * stop the server → extract to a staging dir → overlay (preserving db/,
 * .env, node_modules) → refresh deps + prisma client → rebuild → restart.
 * The live database and the device identity are untouched; the next sync
 * cycle brings the app back to the fleet's data head.
 */
export async function applyAppUpdate(zipPath: string): Promise<boolean> {
  const rt = detectRuntime()
  if (!rt) {
    platformState.lastError = 'app update: no runtime found'
    return false
  }
  plog(`app update: applying ${zipPath}`)
  platformState.status = 'installing'
  setStep('Updating the app (in place)…', 40)

  // 1. stop the supervised server (the payload is being replaced under it)
  if (serverProc) {
    try {
      serverProc.proc.kill()
    } catch {
      /* already gone */
    }
    serverProc = null
  }

  // 2. extract to staging
  const staging = join(PLATFORM_ROOT, 'update-staging')
  rmSync(staging, { recursive: true, force: true })
  const staged = await extractZip(zipPath, staging)
  if (!staged) {
    platformState.lastError = 'app update: payload extraction failed'
    platformState.status = 'error'
    rmSync(staging, { recursive: true, force: true })
    void (async () => {
      const r2 = detectRuntime()
      if (r2 && (await startServer(r2))) await waitForReady()
    })()
    return false
  }

  // 3. overlay (live db/.env/node_modules preserved by UPDATE_PRESERVE_TOP)
  try {
    overlayTree(staging, PLATFORM_DIR)
  } catch (err) {
    platformState.lastError = `app update: overlay failed: ${String(err)}`
    platformState.status = 'error'
    rmSync(staging, { recursive: true, force: true })
    void (async () => {
      const r2 = detectRuntime()
      if (r2 && (await startServer(r2))) await waitForReady()
    })()
    return false
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }

  // 4. the overlay may have refreshed .env templates — re-pin the absolute
  //    db URL and refresh deps (incremental) + the prisma client
  ensureAbsoluteDbUrl()
  setStep('Refreshing dependencies…', 60)
  if (!(await installDependencies(rt, true))) {
    platformState.lastError = 'app update: dependency refresh failed (see platform.log)'
    platformState.status = 'error'
    return false
  }
  if (!(await prismaGenerate(rt))) {
    platformState.lastError = 'app update: prisma generate failed'
    platformState.status = 'error'
    return false
  }

  // 5. force a fresh production build (the code changed — BUILD_ID from the
  //    previous build must not short-circuit)
  try {
    rmSync(join(PLATFORM_DIR, '.next'), { recursive: true, force: true })
  } catch {
    /* build will handle it */
  }
  setStep('Rebuilding the app…', 80)
  await buildProduction(rt)

  // 6. restart + watch
  setStep('Restarting the platform…', 92)
  if (!(await startServer(rt))) {
    platformState.status = 'error'
    return false
  }
  const ready = await waitForReady()
  if (ready) {
    platformState.status = 'running'
    platformState.step = ''
    platformState.progress = 100
  }
  appUpdateState.installedVersion = installedAppVersion()
  plog(`app update: now running app payload ${appUpdateState.installedVersion ?? 'unknown'}`)
  return ready
}

/**
 * Check the cloud for a newer app payload and apply it in place when found.
 * Called by the agent's platform sync cycle (throttled by the caller). Uses
 * the platform's own device credentials against the durable cloud hub.
 */
export async function checkForAppUpdate(): Promise<boolean> {
  if (!cfg?.cloudUrl || !cfg.deviceId || !cfg.deviceKey) return false
  appUpdateState.checking = true
  appUpdateState.installedVersion = installedAppVersion()
  try {
    const res = await fetch(`${cfg.cloudUrl.replace(/\/+$/, '')}/api/desktop/update-manifest`, {
      headers: { 'x-hybrid-device': cfg.deviceId, 'x-hybrid-key': cfg.deviceKey },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const manifest = (await res.json()) as AppUpdateManifest
    appUpdateState.lastCheckAt = nowIso()
    if (!manifest.available || !manifest.url || !manifest.version) {
      appUpdateState.lastResult = `no published payload (${manifest.note ?? 'manifest empty'})`
      return false
    }
    if (!versionNewer(manifest.version, appUpdateState.installedVersion)) {
      appUpdateState.lastResult = `up to date (installed ${appUpdateState.installedVersion ?? 'pre-r68'} · published ${manifest.version})`
      return false
    }
    plog(`app update: ${appUpdateState.installedVersion ?? 'pre-r68'} → ${manifest.version} — downloading…`)
    // download the payload zip
    const dl = await fetch(manifest.url, { signal: AbortSignal.timeout(10 * 60_000) })
    if (!dl.ok) throw new Error(`payload download HTTP ${dl.status}`)
    const zipBytes = Buffer.from(await dl.arrayBuffer())
    if (manifest.size != null && zipBytes.length !== manifest.size) {
      throw new Error(`payload size mismatch (expected ${manifest.size}, got ${zipBytes.length})`)
    }
    const sha = createHash('sha256').update(zipBytes).digest('hex')
    if (manifest.sha256 && manifest.sha256.toLowerCase() !== sha) {
      throw new Error(`payload sha256 mismatch (expected ${manifest.sha256.slice(0, 12)}…, got ${sha.slice(0, 12)}…)`)
    }
    const zipPath = join(PLATFORM_ROOT, 'update-payload.zip')
    writeFileSync(zipPath, zipBytes)
    const ok = await applyAppUpdate(zipPath)
    rmSync(zipPath, { force: true })
    appUpdateState.lastResult = ok
      ? `updated to ${manifest.version} (in place, restarted)`
      : `update to ${manifest.version} FAILED — see platform.log`
    return ok
  } catch (err) {
    appUpdateState.lastResult = `check failed: ${String(err)}`
    plog(`app update check failed: ${String(err)}`)
    return false
  } finally {
    appUpdateState.checking = false
  }
}

/** Whether the platform is installed AND provisioned (dashboard rendering). */
export function platformReady(): boolean {
  return platformState.status === 'running'
}
