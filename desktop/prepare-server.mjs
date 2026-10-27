#!/usr/bin/env node
/**
 * RSM Restaurant Platform — desktop/server assembler (Task 22-c).
 *
 * Runs in CI on windows-latest AFTER the Next.js production build, and is
 * also runnable locally for testing. Pure cross-platform Node (no cp/ln
 * shell commands) so the exact same code works on Windows runners.
 *
 * What it does:
 *   1. Verifies the prerequisites produced by `bunx next build`
 *      (.next/standalone with server.js, .next/static, public, and the
 *      generated Prisma client in node_modules).
 *   2. Copies .next/standalone → desktop/server (replacing any previous copy).
 *   3. Copies .next/static → desktop/server/.next/static and
 *      public → desktop/server/public (the root package.json "build" script
 *      does this with POSIX `cp`, which does not exist on Windows runners —
 *      this script replaces those two copies for CI).
 *   4. PRISMA SAFETY NET: ensures desktop/server/node_modules/.prisma and
 *      desktop/server/node_modules/@prisma exist — Next output tracing has a
 *      known gap where the generated Prisma client (and its native query
 *      engine) is not traced into the standalone tree. If they are missing
 *      (or the engine binary is missing) they are copied from the root
 *      node_modules, which CI regenerates for the build platform
 *      (`bunx prisma generate` on windows-latest → Windows engine).
 *   5. Verifies desktop/server/server.js exists and prints a size summary.
 *
 * Exits non-zero with a clear message when any prerequisite is missing.
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const STANDALONE_SRC = path.join(ROOT, '.next', 'standalone')
const STANDALONE_ENTRY = path.join(STANDALONE_SRC, 'server.js')
const STATIC_SRC = path.join(ROOT, '.next', 'static')
const PUBLIC_SRC = path.join(ROOT, 'public')
const SERVER_DEST = path.join(__dirname, 'server')

const ROOT_PRISMA_CLIENT = path.join(ROOT, 'node_modules', '.prisma')
const ROOT_PRISMA_PACKAGES = path.join(ROOT, 'node_modules', '@prisma')
const DEST_PRISMA_CLIENT = path.join(SERVER_DEST, 'node_modules', '.prisma')
const DEST_PRISMA_PACKAGES = path.join(SERVER_DEST, 'node_modules', '@prisma')

/**
 * Native Prisma query-engine binaries across platforms (v5/v6 names):
 *   Windows : query_engine-windows.dll.node
 *   Linux   : libquery_engine-<distro>.so.node
 *   macOS   : libquery_engine-<distro>.dylib.node
 * All contain "engine" and end in ".node".
 */
const ENGINE_FILE_RE = /engine.*\.node$/i

function fail(message) {
  console.error(`[prepare-server] ERROR: ${message}`)
  process.exit(1)
}

function mustExist(target, what) {
  if (!fs.existsSync(target)) {
    fail(`${what} not found at ${target}. Run the Next.js production build first (bunx prisma generate && bunx next build).`)
  }
}

/** Directory exists AND contains at least one entry. */
function isNonEmptyDir(target) {
  try {
    return fs.statSync(target).isDirectory() && fs.readdirSync(target).length > 0
  } catch {
    return false
  }
}

/** Recursively measure a directory. Returns { bytes, files }. */
function measureDir(target) {
  let bytes = 0
  let files = 0
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) {
        try {
          bytes += fs.statSync(full).size
          files += 1
        } catch {
          /* raced deletion — ignore */
        }
      }
    }
  }
  walk(target)
  return { bytes, files }
}

function mb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Find a native query-engine binary inside a .prisma/client directory. */
function findEngineFile(clientDir) {
  if (!isNonEmptyDir(clientDir)) return null
  try {
    const match = fs.readdirSync(clientDir).find((name) => ENGINE_FILE_RE.test(name))
    return match ? path.join(clientDir, match) : null
  } catch {
    return null
  }
}

// ── 1. prerequisites ───────────────────────────────────────────────────────

mustExist(STANDALONE_SRC, 'Next.js standalone output (.next/standalone)')
mustExist(STANDALONE_ENTRY, 'standalone server entry (.next/standalone/server.js)')
mustExist(STATIC_SRC, 'Next.js static assets (.next/static)')
mustExist(PUBLIC_SRC, 'public assets (public/)')
mustExist(ROOT_PRISMA_CLIENT, 'generated Prisma client (node_modules/.prisma)')
mustExist(ROOT_PRISMA_PACKAGES, '@prisma packages (node_modules/@prisma)')

const rootEngine = findEngineFile(path.join(ROOT_PRISMA_CLIENT, 'client'))
if (!rootEngine) {
  fail(
    `no native Prisma query engine found in ${path.join(ROOT_PRISMA_CLIENT, 'client')} — ` +
      'run `bunx prisma generate` on the build machine before this script.',
  )
}
console.log(`[prepare-server] root Prisma engine: ${path.basename(rootEngine)}`)

// ── 2. fresh copy of the standalone tree ───────────────────────────────────

console.log('[prepare-server] clearing previous desktop/server (if any)')
fs.rmSync(SERVER_DEST, { recursive: true, force: true })

console.log(`[prepare-server] copying ${STANDALONE_SRC} → ${SERVER_DEST}`)
fs.cpSync(STANDALONE_SRC, SERVER_DEST, { recursive: true })

// ── 3. static assets + public files ────────────────────────────────────────

console.log('[prepare-server] copying .next/static → desktop/server/.next/static')
fs.cpSync(STATIC_SRC, path.join(SERVER_DEST, '.next', 'static'), { recursive: true })

console.log('[prepare-server] copying public → desktop/server/public')
fs.cpSync(PUBLIC_SRC, path.join(SERVER_DEST, 'public'), { recursive: true })

// ── 4. Prisma safety net ───────────────────────────────────────────────────

// @prisma/* — copy when tracing missed it entirely.
if (!isNonEmptyDir(DEST_PRISMA_PACKAGES)) {
  console.log('[prepare-server] node_modules/@prisma missing from standalone — copying from root node_modules')
  fs.rmSync(DEST_PRISMA_PACKAGES, { recursive: true, force: true })
  fs.cpSync(ROOT_PRISMA_PACKAGES, DEST_PRISMA_PACKAGES, { recursive: true })
} else {
  console.log('[prepare-server] node_modules/@prisma already present in standalone output')
}

// .prisma — copy when missing, OR when the generated client is present but
// its native engine binary is not (the classic partial-tracing gap).
const destClientDir = path.join(DEST_PRISMA_CLIENT, 'client')
if (!isNonEmptyDir(DEST_PRISMA_CLIENT) || !findEngineFile(destClientDir)) {
  console.log(
    '[prepare-server] node_modules/.prisma (or its native engine) missing from standalone — ' +
      'copying the generated client from root node_modules',
  )
  fs.rmSync(DEST_PRISMA_CLIENT, { recursive: true, force: true })
  fs.cpSync(ROOT_PRISMA_CLIENT, DEST_PRISMA_CLIENT, { recursive: true })
} else {
  console.log('[prepare-server] node_modules/.prisma already present in standalone output')
}

// ── 5. final verification + summary ────────────────────────────────────────

if (!fs.existsSync(path.join(SERVER_DEST, 'server.js'))) {
  fail('desktop/server/server.js is missing after copy — aborting.')
}
const destEngine = findEngineFile(destClientDir)
if (!destEngine) {
  fail(`no native Prisma query engine in ${destClientDir} after the safety-net copy.`)
}

const total = measureDir(SERVER_DEST)
const prismaSize = measureDir(DEST_PRISMA_CLIENT)
console.log('[prepare-server] ── summary ────────────────────────────────────')
console.log(`[prepare-server] desktop/server         : ${total.files} files, ${mb(total.bytes)}`)
console.log(`[prepare-server]   └ node_modules/.prisma: ${mb(prismaSize.bytes)} (${path.basename(destEngine)})`)
console.log(`[prepare-server] server entry           : ${path.join(SERVER_DEST, 'server.js')}`)
console.log('[prepare-server] OK — desktop/server is ready for electron-builder.')
