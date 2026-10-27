// /api/admin/backup/restore — R30 STAGED restore (admin).
//
// Marks a backup for restore WITHOUT touching the live database mid-service:
//  1. the filename is validated against the exact backup pattern (identical
//     allow-list to /api/admin/backup/download — no traversal, backups dir
//     only)
//  2. the backup is COPIED to db/restore-pending.db (the staging slot)
//  3. the copy is integrity-checked via a throwaway PrismaClient pointed at
//     the staged file (SELECT count(*) FROM sqlite_master); an invalid file
//     is deleted immediately and answered 400
//  4. HybridSyncState 'restore.pending' is set
//
// The actual swap happens at the NEXT BOOT (hybrid-engine
// applyStagedRestoreAtBoot): safety snapshot → file swap → marker cleared.
// The response tells the admin a restart completes it.
import { NextRequest, NextResponse } from 'next/server'
import { copyFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'

import { errorResponse, ApiError, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { BACKUP_DIR } from '@/lib/backup'
import { setState, STATE_RESTORE_PENDING } from '@/lib/hybrid-sync/sync-state'

const STAGED_RESTORE_PATH = path.join(process.cwd(), 'db', 'restore-pending.db')

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth(req, ['settings'])
    const body: { filename?: unknown } = await req.json().catch(() => ({}) as { filename?: unknown })
    const filename = typeof body.filename === 'string' ? body.filename : ''

    // Strict allow-list: custom-(auto|manual)-YYYYMMDD-HHMMSS.db — identical
    // to the download route (no traversal, backups dir only)
    if (!/^custom-(auto|manual)-\d{8}-\d{6}\.db$/.test(filename)) {
      return NextResponse.json({ error: 'Invalid backup file name' }, { status: 400 })
    }
    const sourcePath = path.join(BACKUP_DIR, filename)

    // stage the copy (replace any previous staging attempt)
    try {
      await copyFile(sourcePath, STAGED_RESTORE_PATH)
    } catch {
      return NextResponse.json({ error: 'Backup not found' }, { status: 404 })
    }

    // integrity check on the STAGED copy via a throwaway client — the live
    // database is never opened against the candidate
    const probe = new PrismaClient({
      adapter: new PrismaLibSql({ url: `file:${STAGED_RESTORE_PATH}` }), // r49: Prisma 7 adapter
      log: ['error'],
    })
    try {
      const tables = await probe.$queryRawUnsafe<Array<{ n: number | bigint }>>(
        'SELECT COUNT(*) AS n FROM sqlite_master WHERE type = \'table\'',
      )
      const tableCount = Number(tables[0]?.n ?? 0)
      if (tableCount < 5) {
        throw new Error(`staged file looks wrong (${tableCount} tables)`)
      }
    } catch (err) {
      await unlink(STAGED_RESTORE_PATH).catch(() => {})
      console.error('[backup-restore] staged file failed integrity check:', err instanceof Error ? err.message : err)
      return NextResponse.json({ error: 'Backup failed the integrity check' }, { status: 400 })
    } finally {
      await probe.$disconnect()
    }

    await setState(STATE_RESTORE_PENDING, filename)
    await logAudit({
      user: session,
      action: 'backup.restoreStage',
      entity: 'system',
      details: `staged restore from ${filename} — applied at next boot (safety snapshot taken then)`,
    })

    return NextResponse.json({
      staged: true,
      message: 'Restore staged — restart the application to complete it',
    })
  } catch (err) {
    return errorResponse(err)
  }
}
