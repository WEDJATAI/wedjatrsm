import { NextRequest, NextResponse } from 'next/server'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'

import { errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { BACKUP_DIR } from '@/lib/backup'

/**
 * GET /api/admin/backup/download?name=<file> — stream a backup file to the
 * admin browser. The name is strictly validated against the exact backup
 * filename pattern (no traversal, backups dir only) before the file is read.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth(req, ['settings'])
    const rawName = new URL(req.url).searchParams.get('name') ?? ''

    // Strict allow-list: custom-(auto|manual)-YYYYMMDD-HHMMSS.db — path
    // traversal and any other shape are rejected before touching the disk.
    if (!/^custom-(auto|manual)-\d{8}-\d{6}\.db$/.test(rawName)) {
      return NextResponse.json({ error: 'Invalid backup file name' }, { status: 400 })
    }
    const filePath = path.join(BACKUP_DIR, rawName)
    const info = await stat(filePath).catch(() => null)
    if (!info?.isFile()) {
      return NextResponse.json({ error: 'Backup not found' }, { status: 404 })
    }

    await logAudit({
      user: session,
      action: 'backup.download',
      entity: 'system',
      details: `downloaded snapshot ${rawName} (${info.size} bytes)`,
    })

    const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream
    return new NextResponse(stream, {
      headers: {
        'Content-Type': 'application/x-sqlite3',
        'Content-Length': String(info.size),
        'Content-Disposition': `attachment; filename="${rawName}"`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    return errorResponse(err)
  }
}
