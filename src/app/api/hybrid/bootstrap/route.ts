// /api/hybrid/bootstrap — R30 new-device provisioning download.
//
// Device-authenticated. Returns a full snapshot of every hybrid entity (cap
// HYBRID_BOOTSTRAP_CAP rows per table, ordered by id) in `rsm-hybrid/1`
// bundle form — the dataset a freshly installed terminal pulls once, before
// it starts exchanging events. Raw rows are JSON-safe (dates → ISO strings).
import { NextRequest, NextResponse } from 'next/server'

import { errorResponse } from '@/lib/auth'
import { requireDevice } from '@/lib/hybrid-auth'
import { db } from '@/lib/db'
import { HYBRID_ENTITIES } from '@/lib/hybrid-sync/entity-policy'
import { hybridModelFor } from '@/lib/hybrid-sync/dmmf'
import { snapshotRow } from '@/lib/hybrid-sync/outbox'
import { HYBRID_BOOTSTRAP_CAP, HYBRID_FORMAT } from '@/lib/hybrid-sync/constants'

export async function GET(req: NextRequest) {
  try {
    const device = await requireDevice(req)
    if (!device) {
      return NextResponse.json({ error: 'Unauthorized: valid device credentials required' }, { status: 401 })
    }

    const delegates = db as unknown as Record<
      string,
      { findMany: (args: { orderBy: { id: 'asc' }; take: number }) => Promise<Array<Record<string, unknown>>> }
    >

    const tables: Record<string, Array<Record<string, unknown>>> = {}
    for (const entity of Object.keys(HYBRID_ENTITIES)) {
      const model = hybridModelFor(entity)
      const delegate = model ? delegates[model.accessor] : undefined
      if (!model || !delegate) continue
      const rows = await delegate.findMany({ orderBy: { id: 'asc' }, take: HYBRID_BOOTSTRAP_CAP })
      tables[entity] = rows.map((row) => snapshotRow(row))
    }

    return NextResponse.json({
      format: HYBRID_FORMAT,
      generatedAt: new Date().toISOString(),
      tables,
    })
  } catch (err) {
    return errorResponse(err)
  }
}
