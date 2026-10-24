// /api/sync/export — R15 export a rsm-sync/1 bundle (admin/settings).
// POST { mode?: 'delta' | 'full' } (default delta):
//  - delta: rows created after the lastExportAt watermark (all rows when
//    unset) + all open orders with their items and payments (live state).
//  - full: every row of the 9 synced tables.
// On success, delta exports advance the watermark (full exports do not —
// they are snapshots, not incremental markers). Returns { bundle, exportedAt }.

import { NextRequest, NextResponse } from 'next/server'

import { requireAuth, errorResponse } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { buildSyncBundle, markSyncExported, summarizeCounts } from '@/lib/sync'

export async function POST(req: NextRequest) {
  try {
    const user = await requireAuth(req, ['admin', 'settings'])

    let body: Record<string, unknown> = {}
    try {
      const parsed: unknown = await req.json()
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>
      }
    } catch {
      // fall through — invalid/empty JSON is treated as an empty body
    }
    const mode = body.mode === 'full' ? 'full' : 'delta'

    const { bundle, exportedAt } = await buildSyncBundle(mode)
    if (mode === 'delta') await markSyncExported(exportedAt)

    await logAudit({
      user,
      action: 'sync.export',
      entity: 'system',
      entityId: null,
      details: `Exported ${mode} sync bundle (${Object.values(bundle.counts).reduce((a, b) => a + b, 0)} rows): ${summarizeCounts(bundle.counts)}`,
    })

    return NextResponse.json({ bundle, exportedAt: exportedAt.toISOString() })
  } catch (err) {
    return errorResponse(err)
  }
}
