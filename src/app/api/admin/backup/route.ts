import { NextRequest, NextResponse } from 'next/server'

import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { createBackupFile, getAutoBackupStatus, listBackups, maybeAutoBackup } from '@/lib/backup'

const MAX_LISTED = 20

/**
 * GET — list existing backups (newest first) + auto-backup schedule status.
 */
export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['settings'])
    const [backups, auto] = await Promise.all([listBackups(MAX_LISTED), getAutoBackupStatus()])
    return NextResponse.json({ backups, auto })
  } catch (err) {
    return errorResponse(err)
  }
}

/**
 * POST — one-click backup via SQLite `VACUUM INTO` (consistent snapshot,
 * WAL-safe, compacted). Body `{ auto: true }` runs the interval-gated daily
 * job (also fired after logins); default is an immediate manual snapshot.
 * Both paths are audit-logged.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth(req, ['settings'])
    const body = await req.json().catch(() => ({}))

    let backup
    if (body?.auto === true) {
      // interval gate lives in maybeAutoBackup — a manual "auto" trigger
      // only snapshots when the 24h window has elapsed.
      const before = (await getAutoBackupStatus()).lastAt
      await maybeAutoBackup()
      const after = (await getAutoBackupStatus()).lastAt
      if (before === after) {
        // window not elapsed — surface the newest snapshot instead of failing
        const [latest] = await listBackups(1)
        if (!latest) throw new ApiError('Automatic backup window has not elapsed yet', 409)
        return NextResponse.json({ backup: latest, skipped: true })
      }
      const [latest] = await listBackups(1)
      backup = latest
    } else {
      backup = await createBackupFile('manual')
      await logAudit({
        user: session,
        action: 'backup.manual',
        entity: 'system',
        details: `manual snapshot ${backup.name} (${backup.sizeBytes} bytes)`,
      })
    }
    return NextResponse.json({ backup })
  } catch (err) {
    return errorResponse(err)
  }
}
