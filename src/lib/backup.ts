/**
 * R14 backup engine — consistent SQLite snapshots via VACUUM INTO.
 *
 * Why VACUUM INTO (and not fs copyFile): the live database runs in WAL
 * journal mode, so a plain file copy can be torn (the -wal file holds
 * committed transactions the main file may not yet contain). `VACUUM INTO`
 * is SQLite's online-backup primitive: it writes a fully consistent,
 * compacted snapshot while the database keeps serving traffic.
 *
 * Automatic backups: `maybeAutoBackup()` is called after successful logins
 * (a POS terminal always logs in at least once a day). It creates at most
 * one auto backup per 24h and prunes old ones (keeps the newest
 * AUTO_RETENTION). Manual backups from the Settings view are never pruned.
 */
import { mkdir, readdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'

import { db } from '@/lib/db'
import { ApiError } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import type { BackupInfo } from '@/lib/types'

export const BACKUP_DIR = path.join(process.cwd(), 'backups')
export const AUTO_INTERVAL_MS = 24 * 60 * 60 * 1000
export const AUTO_RETENTION = 14
const SETTING_LAST_AUTO = 'lastAutoBackupAt'

/** Module-level guard so concurrent logins can't double-fire the auto job. */
let autoInFlight = false

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** `custom-<kind>-YYYYMMDD-HHMMSS.db` in server local time. */
export function backupFileName(kind: 'auto' | 'manual', now = new Date()): string {
  return (
    `custom-${kind}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.db`
  )
}

/**
 * Resolve the SQLite file path from DATABASE_URL (e.g. `file:/home/z/project/db/custom.db`).
 * Relative `file:` URLs resolve against process.cwd(). Returns null when the URL
 * is not a local file (e.g. a remote Turso/libsql URL in production) — there is
 * no file to back up there, so callers answer 501.
 */
export function resolveDatabaseFile(): string | null {
  const url = process.env.DATABASE_URL ?? ''
  if (!url.startsWith('file:')) return null
  const raw = url.slice('file:'.length)
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw)
}

/**
 * Create a consistent snapshot with `VACUUM INTO` (WAL-safe).
 * The target file must not exist — the timestamped name guarantees that;
 * on the (rare) collision the raw SQLite error surfaces as a 500.
 */
export async function createBackupFile(kind: 'auto' | 'manual'): Promise<BackupInfo> {
  const dbFile = resolveDatabaseFile()
  if (dbFile === null) {
    // R23: on the cloud deployment (Neon Postgres) backups are covered by
    // Neon point-in-time restore + the Turso replica — there is no local file.
    throw new ApiError(
      'File backups are unavailable on the cloud deployment (Neon PITR + the Turso replica cover backups)',
      501,
    )
  }
  const dbStat = await stat(dbFile).catch(() => null)
  if (!dbStat?.isFile()) throw new Error('Database file not found')

  await mkdir(BACKUP_DIR, { recursive: true })
  const name = backupFileName(kind)
  const target = path.join(BACKUP_DIR, name)

  await db.$executeRawUnsafe(`VACUUM INTO '${target.replaceAll("'", "''")}'`)

  const info = await stat(target)
  return { name, sizeBytes: info.size, createdAt: info.mtime.toISOString(), kind }
}

/** List backup files in BACKUP_DIR (newest first). */
export async function listBackups(max = 20): Promise<BackupInfo[]> {
  await mkdir(BACKUP_DIR, { recursive: true })
  const backups: BackupInfo[] = []
  for (const name of await readdir(BACKUP_DIR)) {
    if (!/^custom-(auto|manual)-\d{8}-\d{6}\.db$/.test(name)) continue
    const info = await stat(path.join(BACKUP_DIR, name)).catch(() => null)
    if (!info?.isFile()) continue
    backups.push({
      name,
      sizeBytes: info.size,
      createdAt: info.mtime.toISOString(),
      kind: name.startsWith('custom-auto-') ? 'auto' : 'manual',
    })
  }
  backups.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  return backups.slice(0, max)
}

/** Delete auto backups beyond the retention window (newest AUTO_RETENTION kept). */
async function pruneAutoBackups(): Promise<number> {
  const autos = (await listBackups(Number.MAX_SAFE_INTEGER)).filter((b) => b.kind === 'auto')
  const victims = autos.slice(AUTO_RETENTION)
  for (const v of victims) {
    await unlink(path.join(BACKUP_DIR, v.name)).catch(() => {})
  }
  return victims.length
}

export type AutoBackupStatus = {
  lastAt: string | null
  nextAt: string | null
  intervalHours: number
  retention: number
}

/**
 * Daily auto-backup check — safe to call on every login. Creates a snapshot
 * at most once per AUTO_INTERVAL_MS; never throws (login must not fail
 * because of housekeeping).
 */
export async function maybeAutoBackup(): Promise<void> {
  if (autoInFlight) return
  autoInFlight = true
  try {
    // R23: SQLite-only housekeeping — never attempt on the cloud deployment.
    if (resolveDatabaseFile() === null) return
    const setting = await db.appSetting.findUnique({ where: { key: SETTING_LAST_AUTO } })
    const lastMs = setting ? Date.parse(setting.value) : Number.NaN
    if (Number.isFinite(lastMs) && Date.now() - lastMs < AUTO_INTERVAL_MS) return

    const backup = await createBackupFile('auto')
    const pruned = await pruneAutoBackups()
    await db.appSetting.upsert({
      where: { key: SETTING_LAST_AUTO },
      update: { value: new Date().toISOString() },
      create: { key: SETTING_LAST_AUTO, value: new Date().toISOString() },
    })
    await logAudit({
      action: 'backup.auto',
      entity: 'system',
      details: `automatic snapshot ${backup.name} (${backup.sizeBytes} bytes)${pruned ? `, pruned ${pruned} older auto backup(s)` : ''}`,
    })
  } catch {
    // housekeeping failure must never break login — retry on next login
  } finally {
    autoInFlight = false
  }
}

/** Read the auto-backup schedule status (for the Settings card). */
export async function getAutoBackupStatus(): Promise<AutoBackupStatus> {
  const setting = await db.appSetting.findUnique({ where: { key: SETTING_LAST_AUTO } })
  const lastMs = setting ? Date.parse(setting.value) : null
  const lastAt = lastMs != null && Number.isFinite(lastMs) ? new Date(lastMs).toISOString() : null
  const nextAt = lastAt ? new Date(new Date(lastAt).getTime() + AUTO_INTERVAL_MS).toISOString() : null
  return { lastAt, nextAt, intervalHours: AUTO_INTERVAL_MS / 3_600_000, retention: AUTO_RETENTION }
}
