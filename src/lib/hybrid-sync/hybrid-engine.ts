/**
 * R30 hybrid sync — the engine manager.
 *
 * startHybridEngine(): guarded singleton (globalThis flag, mirroring
 * src/lib/snapshot-watch-init.ts) that ticks every 30 s: push cycle, then
 * pull cycle, never throwing out of the interval, skipping while paused.
 *
 * triggerHybridSyncNow(): the /api/hybrid/sync-now path — runs both cycles
 * immediately; a concurrent request gets { busy: true } (the route answers
 * 409) instead of piling up.
 *
 * applyStagedRestoreAtBoot(): completes a STAGED RESTORE (see
 * /api/admin/backup/restore). At boot, when both the 'restore.pending'
 * marker and db/restore-pending.db exist:
 *   1. safety-snapshot the CURRENT database (VACUUM INTO, WAL-safe —
 *      mirrors src/lib/backup.ts) to backups/pre-restore-<ts>.db
 *   2. rename the live file to db/pre-restore-<ts>.db (keeps the old inode
 *      — the running process continues on it undisturbed)
 *   3. remove the stale -wal/-shm siblings (they belong to the OLD database;
 *      a stale WAL applied over the restored file would corrupt it)
 *   4. copy the staged file to the live path
 *   5. clear the marker + staged file
 * The swap takes effect on the NEXT process start: the running server holds
 * the old inode open by design, so the log line asks for a restart. All
 * steps are best-effort with a rollback (snapshot copied back) if the final
 * copy fails — the live database is never left half-written.
 */
import { copyFile, mkdir, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'

import { db } from '@/lib/db'
import { resolveDatabaseFile } from '@/lib/backup'
import { runPushCycle, type PushCycleResult } from './push'
import { runPullCycle, type PullCycleResult } from './pull'
import { HYBRID_ENGINE_INTERVAL_MS, STATE_ENGINE_RUNNING_SINCE, STATE_RESTORE_PENDING, STATE_SYNC_PAUSED } from './constants'
import { clearState, getState, setState } from './sync-state'

const g = globalThis as typeof globalThis & { __rmsHybridEngineStarted?: boolean }

/** true once startHybridEngine() has run in this process */
export function isEngineRunning(): boolean {
  return g.__rmsHybridEngineStarted === true
}

// p20: ONE cycle at a time, always. The engine tick and admin "Sync now"
// share this flag — concurrent cycles claim DIFFERENT outbox batches and push
// them in parallel, so the receiver applies them out of order; a late-arriving
// lower-revision payload can then overwrite a higher-revision state (found
// live: final-gate orders #590-605 were re-opened on the cloud by their own
// rev-1 create payloads arriving after the rev-3 cancels).
let cycleRunning = false

async function tick(): Promise<void> {
  try {
    if (cycleRunning) return // a sync-now cycle is in flight — skip this tick
    if ((await getState(STATE_SYNC_PAUSED)) === '1') return
    cycleRunning = true
    try {
      await runPushCycle()
      await runPullCycle()
    } finally {
      cycleRunning = false
    }
  } catch (e) {
    // the interval must NEVER throw out of itself — a failing cycle waits
    // for the next tick (and every error path inside the cycles already
    // degrades to recorded state, this is the belt-and-braces catch)
    console.error('[hybrid-engine] cycle failed:', e instanceof Error ? e.message : e)
  }
}

/** Start the background engine (idempotent — safe to call repeatedly). */
export function startHybridEngine(): void {
  if (g.__rmsHybridEngineStarted) return
  g.__rmsHybridEngineStarted = true
  try {
    void setState(STATE_ENGINE_RUNNING_SINCE, new Date().toISOString()).catch(() => {})
    const timer = setInterval(() => void tick(), HYBRID_ENGINE_INTERVAL_MS)
    // never keep the process alive just for syncing
    if (typeof timer.unref === 'function') timer.unref()
    console.log('[hybrid-engine] started (interval 30s)')
  } catch (e) {
    console.warn('[hybrid-engine] failed to start:', e instanceof Error ? e.message : e)
  }
}

export type SyncNowResult =
  | { busy: true }
  | { busy: false; push: PushCycleResult; pull: PullCycleResult }

/** Run both cycles immediately (admin "Sync now"); busy when one is running. */
export async function triggerHybridSyncNow(): Promise<SyncNowResult> {
  if (cycleRunning) return { busy: true }
  cycleRunning = true
  try {
    const push = await runPushCycle()
    const pull = await runPullCycle()
    return { busy: false, push, pull }
  } finally {
    cycleRunning = false
  }
}

// ─── staged restore ───────────────────────────────────────────────────

const STAGED_RESTORE_PATH = path.join(process.cwd(), 'db', 'restore-pending.db')

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function restoreStamp(now = new Date()): string {
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  )
}

/**
 * Apply a staged restore at boot (see module header for the exact dance).
 * Never throws — a failure logs loudly and leaves the staged file + marker
 * in place so the next boot retries.
 */
export async function applyStagedRestoreAtBoot(): Promise<void> {
  try {
    const pending = await getState(STATE_RESTORE_PENDING)
    if (!pending) return

    const stagedInfo = await stat(STAGED_RESTORE_PATH).catch(() => null)
    if (!stagedInfo?.isFile()) {
      // marker set but the staged file is gone — stale marker, clear it
      await clearState(STATE_RESTORE_PENDING)
      console.warn('[hybrid] restore.pending marker set but staged file missing — marker cleared')
      return
    }

    const livePath = resolveDatabaseFile()
    if (!livePath) {
      console.warn('[hybrid] staged restore skipped — DATABASE_URL is not a local file')
      return
    }

    const stamp = restoreStamp()
    const backupsDir = path.join(process.cwd(), 'backups')
    await mkdir(backupsDir, { recursive: true })
    const snapshotPath = path.join(backupsDir, `pre-restore-${stamp}.db`)
    const oldPath = path.join(path.dirname(livePath), `pre-restore-${stamp}.db`)

    // 1) consistent safety snapshot of the CURRENT database (WAL-safe)
    await db.$executeRawUnsafe(`VACUUM INTO '${snapshotPath.replaceAll("'", "''")}'`)

    // 2-4) swap (rename old out of the way, drop stale wal/shm, move staged in)
    try {
      await rename(livePath, oldPath)
      await unlink(`${livePath}-wal`).catch(() => {})
      await unlink(`${livePath}-shm`).catch(() => {})
      await copyFile(STAGED_RESTORE_PATH, livePath)
    } catch (e) {
      // rollback: put the renamed original back (or restore the snapshot)
      await rename(oldPath, livePath).catch(async () => {
        await copyFile(snapshotPath, livePath).catch(() => {})
      })
      throw e
    }

    // 5) clean up marker + staged file
    await unlink(STAGED_RESTORE_PATH).catch(() => {})
    await clearState(STATE_RESTORE_PENDING).catch(() => {})

    console.log(
      `[hybrid] restore applied (${pending}) — restart required to load restored database ` +
        `(pre-restore snapshot: backups/pre-restore-${stamp}.db)`,
    )
  } catch (e) {
    console.error(
      '[hybrid] staged restore FAILED (staged file kept for retry on next boot):',
      e instanceof Error ? e.message : e,
    )
  }
}
