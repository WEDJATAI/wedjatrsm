import { NextRequest, NextResponse } from 'next/server'
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import type { BackupInfo } from '@/lib/types'

const BACKUP_DIR = path.join(process.cwd(), 'backups')
const MAX_LISTED = 20

/**
 * Resolve the SQLite file path from DATABASE_URL (e.g. `file:/home/z/project/db/custom.db`).
 * Relative `file:` URLs resolve against process.cwd(). Returns null when the URL
 * is not a local file (e.g. a remote Turso/libsql URL in production) — there is
 * no file to copy there, so callers answer 501.
 */
function resolveDatabaseFile(): string | null {
  const url = process.env.DATABASE_URL ?? ''
  if (!url.startsWith('file:')) return null
  const raw = url.slice('file:'.length)
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw)
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** `custom-manual-YYYYMMDD-HHMMSS.db` in server local time. */
function backupFileName(now = new Date()): string {
  return (
    `custom-manual-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.db`
  )
}

/** GET — list existing backups (newest first, capped at MAX_LISTED). */
export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['settings'])

    // Missing dir simply means "no backups yet" — create it lazily.
    await mkdir(BACKUP_DIR, { recursive: true })

    const backups: BackupInfo[] = []
    for (const name of await readdir(BACKUP_DIR)) {
      if (!/\.db$/i.test(name)) continue
      const info = await stat(path.join(BACKUP_DIR, name))
      if (!info.isFile()) continue
      backups.push({
        name,
        sizeBytes: info.size,
        createdAt: info.mtime.toISOString(),
      })
    }
    backups.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

    return NextResponse.json({ backups: backups.slice(0, MAX_LISTED) })
  } catch (err) {
    return errorResponse(err)
  }
}

/**
 * POST — one-click backup: copy the SQLite file into /backups.
 *
 * A straight file copy of the live SQLite database is acceptable here: WAL mode
 * is not enabled in this project and writes are short. For production Turso
 * deployments DATABASE_URL is not a `file:` URL, so this handler returns 501
 * (the Settings UI shows a friendly "unavailable" note for that case).
 */
export async function POST(req: NextRequest) {
  try {
    await requireAuth(req, ['settings'])

    const dbFile = resolveDatabaseFile()
    if (dbFile === null) {
      throw new ApiError('File backups are unavailable in this deployment (remote database)', 501)
    }

    const dbStat = await stat(dbFile).catch(() => null)
    if (!dbStat?.isFile()) {
      throw new ApiError('Database file not found', 500)
    }

    await mkdir(BACKUP_DIR, { recursive: true })
    const name = backupFileName()
    const target = path.join(BACKUP_DIR, name)
    await copyFile(dbFile, target)

    const info = await stat(target)
    const backup: BackupInfo = {
      name,
      sizeBytes: info.size,
      createdAt: info.mtime.toISOString(),
    }
    return NextResponse.json({ backup })
  } catch (err) {
    return errorResponse(err)
  }
}
