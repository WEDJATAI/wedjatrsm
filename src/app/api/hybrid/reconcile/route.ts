// /api/hybrid/reconcile — R30 drift reconciliation.
//
// POST with device auth + body { probe: true }  → the CLOUD-SIDE probe mode:
// respond with THIS instance's entity stats (the requester compares against
// its own — this is what runReconciliation() calls).
//
// POST with an admin/settings session → run the full reconciliation from
// THIS instance (fetch the cloud's stats and compare), returning the report.
import { NextRequest, NextResponse } from 'next/server'

import { errorResponse, ApiError } from '@/lib/auth'
import { requireDevice } from '@/lib/hybrid-auth'
import { getSessionUser } from '@/lib/auth'
import { localEntityStats, runReconciliation } from '@/lib/hybrid-sync/reconcile'

export async function POST(req: NextRequest) {
  try {
    const body: { probe?: unknown } = await req.json().catch(() => ({}) as { probe?: unknown })

    // probe mode: a peer device asking for OUR stats
    if (body.probe === true) {
      const device = await requireDevice(req)
      if (!device) {
        return NextResponse.json({ error: 'Unauthorized: valid device credentials required' }, { status: 401 })
      }
      const stats = await localEntityStats()
      return NextResponse.json({ stats })
    }

    // full reconciliation: admin/settings session
    const session = await getSessionUser(req)
    if (!session) throw new ApiError('Unauthorized', 401)
    if (session.role !== 'admin' && !session.permissions.includes('settings')) {
      throw new ApiError('Forbidden: insufficient role', 403)
    }

    const report = await runReconciliation()
    return NextResponse.json(report)
  } catch (err) {
    return errorResponse(err)
  }
}
