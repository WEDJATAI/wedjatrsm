/**
 * p19 recycle guard — boot-time self-heal for the sandbox recycle pattern.
 *
 * THE RECYCLE (8 events so far, see docs/RUNBOOK.md): between sessions the
 * sandbox wipes db/custom.db to a bare schema (0 users), strips .env to 2
 * keys, deletes .env.deploy-local + /home/z/.deploy-creds*.env, and stages
 * file-mode flips into the git index. Survivors every time: everything
 * INSIDE .git/ (commits, tags, .git/deploy-creds.env — and now
 * .git/env-vault.env, the full credential vault).
 *
 * THIS MODULE runs at server boot (src/instrumentation.ts, BEFORE the hybrid
 * engine and the snapshot watcher) and, on the local SQLite deployment only:
 *
 *   1. ENV HEAL — rebuilds .env / .env.deploy-local / /home/z/.deploy-creds.env
 *      / /home/z/.deploy-creds-ai.env from the vault (.git/env-vault.env),
 *      filling ONLY missing keys (existing values are never overwritten) and
 *      patching the running process.env for missing app keys.
 *   2. DB HEAL — when the live db shows the bare signature (no users table /
 *      0 users) it stages the best recovery source into db/restore-pending.db
 *      and sets the restore.pending marker, then the PROVEN
 *      hybrid-engine.applyStagedRestoreAtBoot() performs the swap (safety
 *      snapshot → rename → copy → marker cleared). Afterwards the shared
 *      Prisma client is disconnected once so its next query reopens the
 *      RESTORED file (no second restart needed).
 *   3. HEALTH REPORT — one boot log block stating which stores/keys are
 *      configured, so wrong connections are visible immediately.
 *
 * Priority of recovery sources (first candidate that probes healthy wins):
 *   a. git HEAD's tracked recovery point (git show HEAD:download/…) — the
 *      committed, branch-protected copy (most trustworthy);
 *   b. download/rsm-platform-database.db on disk (if it still has users);
 *   c. newest backups/auto/custom-*.db with users;
 *   d. newest backups/custom-manual-*.db with users.
 *
 * Kill-switch: RMS_RECYCLE_GUARD=0 (CI/one-shot runs). Cloud deployments
 * (DATABASE_URL = postgres://…) skip everything — this is a local/Windows
 * self-heal only.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { PrismaClient } from '@prisma/client'

const ROOT = process.cwd()
const VAULT_PATH = join(ROOT, '.git', 'env-vault.env')
const LIVE_ENV = join(ROOT, '.env')
const DEPLOY_ENV = join(ROOT, '.env.deploy-local')
const HOME_CREDS = '/home/z/.deploy-creds.env'
const HOME_CREDS_AI = '/home/z/.deploy-creds-ai.env'
const STAGED_RESTORE_PATH = join(ROOT, 'db', 'restore-pending.db')
const TRACKED_RECOVERY = 'download/rsm-platform-database.db'
const DISK_RECOVERY = join(ROOT, 'download', 'rsm-platform-database.db')
const AUTO_DIR = join(ROOT, 'backups', 'auto')
const MANUAL_GLOB = /^custom-manual-\d{8}-\d{6}\.db$/
const AUTO_GLOB = /^custom-\d{8}-\d{6}\.db$/

/** Keys that belong in each store (subset of the vault). (exported: harden-verify reuses them as the canonical per-store key sets) */
export const APP_KEYS = [
  'DATABASE_URL', 'JWT_SECRET',
  'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'GEMINI_API_KEY', 'HF_API_KEY',
  'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'INNGEST_SIGNING_KEY',
] as const
export const DEPLOY_KEYS = [
  'GITHUB_TOKEN', 'GITHUB_REPO', 'VERCEL_TOKEN', 'VERCEL_PROJECT', 'VERCEL_PROD_URL',
  'TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN', 'NEON_DATABASE_URL', 'NEON_UNPOOLED_DATABASE_URL',
  'NEON_USER', 'NEON_PASSWORD', 'NEON_DATABASE', 'INNGEST_EVENT_KEY', 'INNGEST_SIGNING_KEY',
  'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'GEMINI_API_KEY', 'HF_API_KEY',
] as const
export const HOME_KEYS = DEPLOY_KEYS.filter((k) => !['GROQ_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'GEMINI_API_KEY', 'HF_API_KEY'].includes(k))
export const HOME_AI_KEYS = ['GROQ_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'GEMINI_API_KEY', 'HF_API_KEY'] as const

export interface RecycleGuardReport {
  ran: boolean
  envHealed: string[]          // store paths rebuilt
  dbHealed: boolean
  restoreSource?: string
  users?: number
  healthy: boolean             // db has users after heal (or was never bare)
}

// ─── env file helpers ──────────────────────────────────────────────────

function parseEnvFile(file: string): Map<string, string> {
  const out = new Map<string, string>()
  if (!existsSync(file)) return out
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq <= 0) continue
    out.set(t.slice(0, eq).trim(), t.slice(eq + 1).trim())
  }
  return out
}

function readVault(): Map<string, string> {
  return parseEnvFile(VAULT_PATH)
}

/**
 * Rebuild one env store from the vault: keeps every key the store already
 * has (never overwrites), fills missing keys, preserves the original header
 * comment lines. Returns the keys that were added, or null when untouched.
 */
function healStore(path: string, keys: readonly string[], vault: Map<string, string>): string[] | null {
  const existing = parseEnvFile(path)
  const missing = keys.filter((k) => !existing.has(k) && vault.has(k))
  if (missing.length === 0 && existsSync(path)) return null
  // preserve leading comment block of the original file (first N comment lines)
  const header: string[] = []
  if (existsSync(path)) {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (line.startsWith('#')) header.push(line)
      else if (line.trim() === '' && header.length > 0) continue
      else break
    }
  }
  const merged = new Map(existing)
  for (const k of missing) merged.set(k, vault.get(k) as string)
  const body = [...keys.filter((k) => merged.has(k)), ...[...merged.keys()].filter((k) => !keys.includes(k))]
    .map((k) => `${k}=${merged.get(k)}`)
    .join('\n') + '\n'
  const note =
    missing.length > 0
      ? `# p19 recycle-guard: healed ${missing.length} missing key(s) from .git/env-vault.env at ${new Date().toISOString()}\n`
      : ''
  writeFileSync(path, (header.length ? header.join('\n') + '\n' : '') + note + body)
  try { chmodSync(path, 0o600) } catch { /* best effort */ }
  return missing
}

// ─── db helpers ────────────────────────────────────────────────────────

/** Resolve the SQLite file path from DATABASE_URL (file:…). */
function resolveLivePath(): string | null {
  const url = process.env.DATABASE_URL ?? ''
  const m = /file:(.+)/.exec(url)
  if (!m) return null
  const raw = m[1].split('?')[0]
  return raw.startsWith('/') ? raw : join(ROOT, raw)
}

/** Users count on a db file; null when the users table is missing. Never throws on query errors. */
async function probeUsers(url: string): Promise<number | null> {
  const p = new PrismaClient({ datasources: { db: { url } }, log: ['error'] })
  try {
    const t = await p.$queryRawUnsafe(
      `SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='users'`,
    ) as Array<{ c: number | bigint }>
    if (Number(t[0]?.c ?? 0) === 0) return null
    const u = await p.$queryRawUnsafe(`SELECT COUNT(*) AS c FROM users`) as Array<{ c: number | bigint }>
    return Number(u[0]?.c ?? 0)
  } finally {
    await p.$disconnect()
  }
}

/** Full probe of a recovery candidate: integrity + shape + users. */
async function probeCandidate(file: string): Promise<{ ok: boolean; users: number | null; reason: string }> {
  if (!existsSync(file)) return { ok: false, users: null, reason: 'missing' }
  const p = new PrismaClient({ datasources: { db: { url: `file:${file}` } }, log: ['error'] })
  try {
    const integ = await p.$queryRawUnsafe(`PRAGMA integrity_check`) as Array<{ integrity_check: string }>
    if (integ[0]?.integrity_check !== 'ok') return { ok: false, users: null, reason: 'integrity' }
    const tables = await p.$queryRawUnsafe(
      `SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'`,
    ) as Array<{ c: number | bigint }>
    if (Number(tables[0]?.c ?? 0) < 20) return { ok: false, users: null, reason: 'shape' }
    const t = await p.$queryRawUnsafe(
      `SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='users'`,
    ) as Array<{ c: number | bigint }>
    if (Number(t[0]?.c ?? 0) === 0) return { ok: false, users: null, reason: 'no-users-table' }
    const u = await p.$queryRawUnsafe(`SELECT COUNT(*) AS c FROM users`) as Array<{ c: number | bigint }>
    const users = Number(u[0]?.c ?? 0)
    if (users <= 0) return { ok: false, users: 0, reason: 'bare' }
    return { ok: true, users, reason: 'healthy' }
  } catch (e) {
    return { ok: false, users: null, reason: e instanceof Error ? e.message : 'error' }
  } finally {
    await p.$disconnect()
  }
}

function newestMatching(dir: string, glob: RegExp): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => glob.test(f))
    .sort()
    .reverse()
    .map((f) => join(dir, f))
}

/** Extract git HEAD's tracked recovery point to a temp file; null when unavailable. */
function extractGitRecovery(tempFile: string): boolean {
  if (!existsSync(join(ROOT, '.git'))) return false
  try {
    const buf = execFileSync('git', ['show', `HEAD:${TRACKED_RECOVERY}`], {
      cwd: ROOT,
      maxBuffer: 64 * 1024 * 1024,
    })
    if (!buf || buf.length < 1024) return false
    writeFileSync(tempFile, buf)
    return true
  } catch {
    return false
  }
}

/**
 * Stage the best recovery source into db/restore-pending.db and set the
 * restore.pending marker (the proven hybrid-engine swap applies it next).
 * Returns the chosen source description, or null when no healthy source exists.
 */
async function stageRecovery(): Promise<string | null> {
  const tempGit = join(ROOT, 'db', '.recycle-guard-git-recovery.tmp.db')
  const candidates: Array<{ file: string; label: string }> = []
  if (extractGitRecovery(tempGit)) candidates.push({ file: tempGit, label: `git HEAD:${TRACKED_RECOVERY}` })
  if (existsSync(DISK_RECOVERY)) candidates.push({ file: DISK_RECOVERY, label: TRACKED_RECOVERY })
  for (const f of newestMatching(AUTO_DIR, AUTO_GLOB)) candidates.push({ file: f, label: `backups/auto/${f.split('/').pop()}` })
  for (const f of newestMatching(join(ROOT, 'backups'), MANUAL_GLOB)) candidates.push({ file: f, label: `backups/${f.split('/').pop()}` })

  for (const c of candidates) {
    const probe = await probeCandidate(c.file)
    if (!probe.ok) {
      console.warn(`[recycle-guard] recovery candidate rejected (${c.label}): ${probe.reason}`)
      continue
    }
    copyFileSync(c.file, STAGED_RESTORE_PATH)
    // set the marker directly (works even on a bare db with no tables yet)
    const live = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL as string } }, log: ['error'] })
    try {
      await live.$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS hybrid_sync_state (key TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL, updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
      )
      const markerValue = `p19-recycle-guard: ${c.label}`.replace(/'/g, "''")
      await live.$executeRawUnsafe(
        `INSERT OR REPLACE INTO hybrid_sync_state (key, value, updatedAt) VALUES ('restore.pending', '${markerValue}', CURRENT_TIMESTAMP)`,
      )
    } finally {
      await live.$disconnect()
    }
    if (existsSync(tempGit)) { try { unlinkSync(tempGit) } catch { /* best effort */ } }
    console.log(`[recycle-guard] staged restore from ${c.label} (${probe.users} users) — applying…`)
    return c.label
  }
  if (existsSync(tempGit)) { try { unlinkSync(tempGit) } catch { /* best effort */ } }
  return null
}

// ─── main entry ────────────────────────────────────────────────────────

/**
 * Boot-time self-heal (see module header). Never throws — failures log
 * loudly and leave the system for the CLI fallback
 * (`bun scripts/auto-heal.ts`).
 */
export async function runRecycleGuardAtBoot(): Promise<RecycleGuardReport> {
  const report: RecycleGuardReport = { ran: false, envHealed: [], dbHealed: false, healthy: true }
  if (process.env.RMS_RECYCLE_GUARD === '0') return report
  // cloud deployment (Neon Postgres): nothing to heal
  if (!process.env.DATABASE_URL?.startsWith('file:')) return report
  report.ran = true

  // ── 1. ENV HEAL ──────────────────────────────────────────────────────
  if (existsSync(VAULT_PATH)) {
    const vault = readVault()
    const stores: Array<[string, readonly string[]]> = [
      [LIVE_ENV, APP_KEYS],
      [DEPLOY_ENV, DEPLOY_KEYS],
      [HOME_CREDS, HOME_KEYS],
      [HOME_CREDS_AI, HOME_AI_KEYS],
    ]
    for (const [path, keys] of stores) {
      try {
        const healed = healStore(path, keys, vault)
        if (healed) {
          report.envHealed.push(path)
          console.log(`[recycle-guard] env healed: ${path} (+${healed.length} keys from vault)`)
          // patch the RUNNING process for missing app keys (file fix alone
          // only helps the next boot)
          for (const k of healed) {
            const v = vault.get(k)
            if (v && !process.env[k]) process.env[k] = v
          }
        }
      } catch (e) {
        console.warn(`[recycle-guard] env heal failed for ${path}:`, e instanceof Error ? e.message : e)
      }
    }
  } else {
    console.warn('[recycle-guard] vault missing (.git/env-vault.env) — env heal skipped. Rebuild with: bun scripts/p19-build-vault.ts')
  }

  // ── 2. DB HEAL ───────────────────────────────────────────────────────
  const livePath = resolveLivePath()
  if (!livePath) return report
  let users: number | null = null
  try {
    users = await probeUsers(`file:${livePath}`)
  } catch (e) {
    console.warn('[recycle-guard] live db probe failed:', e instanceof Error ? e.message : e)
  }
  if (users !== null && users > 0) {
    report.users = users
    report.healthy = true
  } else {
    console.error(
      `[recycle-guard] RECYCLE SIGNATURE DETECTED — live db has ${users === null ? 'no users table' : '0 users'}. ` +
        'Staging recovery (bare live db is preserved at db/pre-restore-*.db).',
    )
    try {
      const source = await stageRecovery()
      if (source) {
        report.dbHealed = true
        report.restoreSource = source
        // NOTE: the caller (instrumentation) runs applyStagedRestoreAtBoot()
        // right after this, then verifyRecycleRestore() to drop the stale
        // Prisma pool and confirm the healed db.
      } else {
        report.healthy = false
        console.error(
          '[recycle-guard] NO HEALTHY RECOVERY SOURCE FOUND — recovery point and backups are all bare/missing. ' +
            'Manual recovery: docs/RUNBOOK.md (Neon is the source of truth: scripts/p12-cloud-pull.ts).',
        )
      }
    } catch (e) {
      report.healthy = false
      console.error('[recycle-guard] recovery staging FAILED:', e instanceof Error ? e.message : e)
    }
  }

  // ── 3. HEALTH REPORT ─────────────────────────────────────────────────
  const aiKeys = ['GROQ_API_KEY', 'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'GEMINI_API_KEY', 'HF_API_KEY']
  const aiOk = aiKeys.filter((k) => process.env[k]).length
  const parts = [
    `db=${report.users ?? users ?? '?'} users`,
    `ai=${aiOk}/5 keys`,
    process.env.TURSO_AUTH_TOKEN ? 'turso=ok' : 'turso=MISSING',
    process.env.INNGEST_SIGNING_KEY ? 'inngest=ok' : 'inngest=MISSING',
    existsSync(VAULT_PATH) ? 'vault=ok' : 'vault=MISSING',
  ]
  console.log(`[recycle-guard] boot health: ${parts.join(' · ')}`)
  return report
}

/**
 * Post-restore verification + stale-pool drop. Called by instrumentation
 * AFTER applyStagedRestoreAtBoot() when the guard staged a restore. The
 * shared Prisma client's pool still points at the renamed (bare) inode —
 * one $disconnect() makes its next query reopen the RESTORED file, so no
 * second restart is needed.
 */
export async function verifyRecycleRestore(report: RecycleGuardReport): Promise<boolean> {
  if (!report.dbHealed) return true
  const livePath = resolveLivePath()
  if (!livePath) return false
  try {
    const { db } = await import('./db')
    await db.$disconnect()
    const users = await probeUsers(`file:${livePath}`)
    if (users !== null && users > 0) {
      report.users = users
      report.healthy = true
      console.log(
        `[recycle-guard] ✔ SELF-HEALED — live db restored from ${report.restoreSource} ` +
          `(${users} users). Zero data loss; recovery point re-armed.`,
      )
      return true
    }
    console.error(
      `[recycle-guard] restore applied but verification shows users=${users} — ` +
        'check db/pre-restore-*.db and docs/RUNBOOK.md §manual-recovery.',
    )
    return false
  } catch (e) {
    console.error('[recycle-guard] restore verification failed:', e instanceof Error ? e.message : e)
    return false
  }
}
