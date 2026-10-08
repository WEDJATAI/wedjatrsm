/**
 * RSM Restaurant Platform — Electron main process (Task 22-c).
 *
 * Architecture:
 *   This shell does NOT reimplement the platform. It bundles the Next.js
 *   standalone production server (desktop/server, assembled by
 *   prepare-server.mjs in CI) and runs it as a child process on a free
 *   localhost port, then renders it in a BrowserWindow. The user's data
 *   (SQLite database + JWT secret) lives per-installation under
 *   app.getPath('userData') so every PC gets an isolated, persistent store.
 *
 * Lifecycle:
 *   app ready → prepare data dir + seed DB + JWT secret → pick a free port
 *   → spawn server (process.execPath with ELECTRON_RUN_AS_NODE=1, asar is
 *   off so server/server.js is a real file on disk) → poll http readiness
 *   → open window → start auto-update checks.
 *
 * Auto-update (the core requirement of 22-c):
 *   electron-updater + GitHub Releases. Checks on launch and every 30 min,
 *   downloads in the background (autoDownload) and installs automatically
 *   on the next quit (autoInstallOnAppQuit). We deliberately do NOT call
 *   quitAndInstall() from the update-downloaded handler — restaurant staff
 *   may be mid-shift; the install happens whenever they close the app.
 *
 * Every step is wrapped so a failure logs and degrades rather than crashing;
 * only true dead-ends (no database, server won't start) surface an error box
 * and exit(1).
 */

'use strict'

const { app, BrowserWindow, dialog, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

const APP_TITLE = 'RSM Restaurant Platform'
const APP_ID = 'com.wedjatai.rsm'

/** Preferred local ports for the bundled server (4312, then 4313..4321). */
const PORT_CANDIDATES = [4312, 4313, 4314, 4315, 4316, 4317, 4318, 4319, 4320, 4321]

/** How long to wait for the server to answer HTTP before giving up. */
const SERVER_READY_TIMEOUT_MS = 60_000
/** Interval between readiness probes. */
const SERVER_POLL_INTERVAL_MS = 300
/** How often to re-check GitHub for updates (30 minutes). */
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000

// ── mutable state ──────────────────────────────────────────────────────────
let mainWindow = null
let serverChild = null
let serverReady = false
let serverPort = null
let quitting = false

// ═══════════════════════════════════ utilities ════════════════════════════

function log(tag, ...args) {
  console.log(`[${tag}]`, ...args)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Show an error box (if possible) and exit(1). Used only for dead-ends. */
function fatal(err) {
  const message = err instanceof Error ? (err.stack || err.message) : String(err)
  if (quitting) {
    // The user asked to quit mid-startup — not an error, exit quietly.
    log('main', 'startup aborted (app is quitting):', message)
    killServer()
    app.exit(0)
    return
  }
  log('main', 'FATAL:', message)
  try {
    dialog.showErrorBox(
      `${APP_TITLE} — cannot start`,
      `${message}\n\nTry restarting the app. If the problem repeats, contact your system administrator.`,
    )
  } catch (dialogErr) {
    log('main', 'error box unavailable:', dialogErr instanceof Error ? dialogErr.message : dialogErr)
  }
  killServer()
  app.exit(1)
}

// ════════════════════════════ data / secrets ══════════════════════════════

/**
 * Ensure <userData>/data exists and holds a database.
 * First run: copy the packaged seed DB (extraResources → resources/seed.db)
 * to data/custom.db. DATABASE_URL uses forward slashes (Prisma requirement
 * on Windows — backslashes are not allowed in file: URLs).
 */
function ensureDatabase(dataDir) {
  const dbPath = path.join(dataDir, 'custom.db')
  if (fs.existsSync(dbPath)) return dbPath

  const seedPath = app.isPackaged
    ? path.join(process.resourcesPath, 'seed.db')
    : path.join(__dirname, 'resources', 'seed.db')

  if (!fs.existsSync(seedPath)) {
    throw new Error(`Seed database not found (expected at ${seedPath}). The installation appears to be incomplete.`)
  }
  fs.copyFileSync(seedPath, dbPath)
  log('main', `first run — seeded database from ${seedPath}`)
  return dbPath
}

/**
 * Per-installation JWT secret (64 hex chars = 32 random bytes), generated
 * once and persisted to <userData>/jwt-secret so login sessions survive
 * app restarts. Without this the platform would generate a new secret per
 * process and log everybody out on every launch.
 */
function ensureJwtSecret() {
  const secretPath = path.join(app.getPath('userData'), 'jwt-secret')
  try {
    const existing = fs.readFileSync(secretPath, 'utf8').trim()
    if (/^[0-9a-f]{64}$/.test(existing)) return existing
    if (existing) {
      // Present but not the expected shape — keep using it rather than
      // invalidating existing sessions.
      return existing
    }
  } catch {
    // First run — no secret file yet.
  }
  const secret = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(secretPath, secret, { mode: 0o600 })
  log('main', `generated per-installation JWT secret at ${secretPath}`)
  return secret
}

// ═══════════════════════════════ port search ══════════════════════════════

/** Resolve with a free port, or null if `port` is taken/unusable. */
function probePort(port) {
  return new Promise((resolve) => {
    const probe = net.createServer()
    const fail = () => resolve(null)
    probe.once('error', fail)
    probe.listen(port, '127.0.0.1', () => {
      const assigned = probe.address().port
      probe.close(() => resolve(assigned))
    })
  })
}

/** Try 4312, then 4313..4321, then let the OS pick (port 0). */
async function findFreePort() {
  for (const candidate of PORT_CANDIDATES) {
    const port = await probePort(candidate)
    if (port) return port
  }
  const fallback = await probePort(0)
  if (fallback) return fallback
  throw new Error('Could not reserve a local TCP port for the RSM server.')
}

// ══════════════════════════════ server child ══════════════════════════════

/**
 * Spawn the bundled Next.js standalone server WITHOUT bundling Node:
 * process.execPath is this Electron binary; ELECTRON_RUN_AS_NODE=1 turns it
 * into a plain Node runtime for the child. cwd is the user's data dir so
 * every relative path the platform writes (backups/, snapshots, exports)
 * stays inside the installation's own data folder.
 */
function startServer({ port, dbUrl, jwtSecret, dataDir }) {
  const serverJsPath = path.join(__dirname, 'server', 'server.js')
  if (!fs.existsSync(serverJsPath)) {
    throw new Error(`Bundled server not found (expected at ${serverJsPath}). The installation appears to be incomplete.`)
  }

  serverChild = spawn(process.execPath, [serverJsPath], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      DATABASE_URL: dbUrl,
      JWT_SECRET: jwtSecret,
    },
    cwd: dataDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  // MUST consume the pipes or the child blocks once the OS buffer fills.
  serverChild.stdout.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) log('server', line)
    }
  })
  serverChild.stderr.on('data', (chunk) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) log('server', line)
    }
  })
  serverChild.on('error', (err) => {
    log('server', 'failed to spawn:', err.message)
  })
  serverChild.on('exit', (code, signal) => {
    log('server', `exited (code=${code} signal=${signal})`)
  })

  log('main', `server started on http://127.0.0.1:${port} (pid ${serverChild.pid})`)
}

/** Stop the server child (idempotent). Called on before-quit and will-quit. */
function killServer() {
  const child = serverChild
  serverChild = null
  if (!child || child.exitCode !== null) return
  try {
    child.kill()
  } catch (err) {
    log('server', 'kill failed:', err instanceof Error ? err.message : err)
  }
  if (process.platform === 'win32' && child.pid) {
    // Fallback for Windows: SIGTERM-equivalents don't cascade to
    // grandchildren, so also ask taskkill to take down the whole tree.
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } catch (err) {
      log('server', 'taskkill fallback failed:', err instanceof Error ? err.message : err)
    }
  }
}

/** Resolve true as soon as `url` answers with ANY http status code. */
function httpResponds(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume() // drain the socket
      resolve(true)
    })
    req.on('error', () => resolve(false))
    req.setTimeout(2000, () => {
      req.destroy()
      resolve(false)
    })
  })
}

/**
 * Poll the server until it answers. Resolves true when ready, false when
 * the app is quitting mid-startup; throws on timeout or early child exit.
 */
async function waitForServer(port) {
  const url = `http://127.0.0.1:${port}/`
  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (quitting) return false
    if (!serverChild || serverChild.exitCode !== null) {
      throw new Error('The bundled RSM server exited before becoming ready — see the logs above.')
    }
    if (await httpResponds(url)) {
      serverReady = true
      log('main', 'server is ready')
      return
    }
    await sleep(SERVER_POLL_INTERVAL_MS)
  }
  throw new Error(`The bundled RSM server did not respond within ${SERVER_READY_TIMEOUT_MS / 1000}s.`)
}

// ════════════════════════════════ window ══════════════════════════════════

function createWindow(port) {
  const baseOptions = {
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 680,
    title: APP_TITLE,
    autoHideMenuBar: true,
    show: false, // shown on first paint (ready-to-show) to avoid a white flash
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  }

  // The icon only exists as a loose file in dev; in the packaged app the
  // window/taskbar icon comes from the embedded exe icon, so a missing file
  // must never be fatal (guard with try).
  let win
  try {
    win = new BrowserWindow({
      ...baseOptions,
      icon: path.join(__dirname, 'resources', 'icon.png'),
    })
  } catch (err) {
    log('main', 'icon unavailable, using default:', err instanceof Error ? err.message : err)
    win = new BrowserWindow(baseOptions)
  }

  win.once('ready-to-show', () => {
    try {
      win.show()
    } catch (err) {
      log('main', 'show failed:', err instanceof Error ? err.message : err)
    }
    setupAutoUpdate()
  })

  // External links (target=_blank / window.open to anything that is not this
  // app's localhost server) go to the system browser.
  try {
    win.webContents.setWindowOpenHandler(({ url }) => {
      try {
        const parsed = new URL(url)
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
            return { action: 'allow' }
          }
          log('main', 'opening external link in system browser:', url)
          shell.openExternal(url)
        } else {
          log('main', 'refusing to open non-http URL:', url)
        }
      } catch {
        log('main', 'refusing to open malformed URL:', url)
      }
      return { action: 'deny' }
    })
  } catch (err) {
    log('main', 'window-open handler setup failed:', err instanceof Error ? err.message : err)
  }

  win.loadURL(`http://127.0.0.1:${port}/`).catch((err) => {
    log('main', 'loadURL failed:', err instanceof Error ? err.message : err)
  })

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  mainWindow = win
  return win
}

// ═════════════════════════════ auto-update ════════════════════════════════

/**
 * Wire electron-updater → GitHub Releases.
 *
 * Behavior: check on launch + every 30 min; downloads are automatic
 * (autoDownload); installation is automatic on the NEXT QUIT
 * (autoInstallOnAppQuit). We intentionally never call quitAndInstall()
 * from here — a restaurant terminal must never restart mid-shift. Staff
 * just close the app at some point and the new version is in place on the
 * next launch.
 *
 * Runs only in packaged builds (dev has no app-update.yml / release feed).
 */
function setupAutoUpdate() {
  if (!app.isPackaged) {
    log('updater', 'development mode — auto-update disabled')
    return
  }

  let autoUpdater
  try {
    // Lazy require so a missing/broken dependency degrades to "no updates"
    // instead of killing the whole app.
    autoUpdater = require('electron-updater').autoUpdater
  } catch (err) {
    log('updater', 'electron-updater unavailable — auto-update disabled:', err instanceof Error ? err.message : err)
    return
  }

  try {
    autoUpdater.logger = {
      info: (message) => log('updater', message),
      warn: (message) => log('updater', 'warn:', message),
      error: (message) => log('updater', 'error:', message),
      debug: (message) => log('updater', 'debug:', message),
    }
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true

    autoUpdater.on('checking-for-update', () => log('updater', 'checking for updates…'))
    autoUpdater.on('update-available', (info) =>
      log('updater', `update available (v${info && info.version}) — downloading in the background…`),
    )
    autoUpdater.on('update-not-available', () => log('updater', 'up to date — no update available'))
    autoUpdater.on('download-progress', (progress) => {
      if (progress && typeof progress.percent === 'number') {
        log('updater', `downloading update: ${progress.percent.toFixed(1)}%`)
      }
    })
    autoUpdater.on('update-downloaded', (info) => {
      // Deliberately subtle: console only, no forced restart. The new
      // version installs automatically when the app is next quit
      // (autoInstallOnAppQuit). If an immediate install is ever needed,
      // autoUpdater.quitAndInstall() exists — it is intentionally NOT
      // called automatically here to protect staff mid-shift.
      log(
        'updater',
        `update v${info && info.version} DOWNLOADED — it will be installed automatically the next time the app is closed.`,
      )
    })
    autoUpdater.on('error', (err) => log('updater', 'error:', err instanceof Error ? err.message : err))

    const check = () =>
      autoUpdater.checkForUpdatesAndNotify().catch((err) =>
        log('updater', 'check failed:', err instanceof Error ? err.message : err),
      )

    check()
    setInterval(check, UPDATE_CHECK_INTERVAL_MS)
    log('updater', 'auto-update enabled (checks on launch + every 30 minutes, installs on next quit)')
  } catch (err) {
    // Never let the updater break the app.
    log('updater', 'setup failed — continuing without auto-update:', err instanceof Error ? err.message : err)
  }
}

// ═══════════════════════════════ bootstrap ════════════════════════════════

async function main() {
  try {
    app.setAppUserModelId(APP_ID) // correct toast/taskbar identity on Windows
  } catch (err) {
    log('main', 'setAppUserModelId failed (non-fatal):', err instanceof Error ? err.message : err)
  }

  // 1. Per-user data dir + first-run seed + persistent secrets.
  const dataDir = path.join(app.getPath('userData'), 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  const dbPath = ensureDatabase(dataDir)
  // Prisma file: URLs require forward slashes (Windows paths use backslashes).
  const dbUrl = `file:${dbPath.split(path.sep).join('/')}`
  const jwtSecret = ensureJwtSecret()

  // 2. A free port, then the bundled server.
  const port = await findFreePort()
  serverPort = port
  startServer({ port, dbUrl, jwtSecret, dataDir })

  // 3. Wait for HTTP readiness (also detects early child exit).
  if (!(await waitForServer(port))) return // user quit during startup

  // 4. UI (auto-update starts once the window is visible).
  createWindow(port)
}

// ── single instance: a second launch just focuses the first window ────────
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    try {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.focus()
      }
    } catch (err) {
      log('main', 'second-instance focus failed:', err instanceof Error ? err.message : err)
    }
  })

  app.whenReady().then(main).catch(fatal)

  app.on('window-all-closed', () => {
    // Standard quit for a dedicated app window (not a macOS dock app).
    app.quit()
  })

  app.on('before-quit', () => {
    quitting = true
    killServer()
  })
  app.on('will-quit', () => {
    quitting = true
    killServer()
  })

  app.on('activate', () => {
    // macOS nicety — re-open the window when the dock icon is clicked.
    if (mainWindow === null && serverPort) createWindow(serverPort)
  })
}
