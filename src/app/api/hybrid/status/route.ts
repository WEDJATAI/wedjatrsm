// /api/hybrid/status — R30 engine health snapshot.
//
// Dual auth: an admin/settings session (the Sync Center UI) OR an active
// device. Returns buildHealthSnapshot() plus a server-side best-effort
// internet verdict; the client UI merges it with navigator.onLine.
import { NextRequest, NextResponse } from 'next/server'

import { errorResponse } from '@/lib/auth'
import { requireSessionOrDevice } from '@/lib/hybrid-auth'
import { buildHealthSnapshot } from '@/lib/hybrid-sync/health'
import { STATE_CLOUD_LAST_CHECKED, STATE_CLOUD_REACHABLE } from '@/lib/hybrid-sync/constants'
import { getState } from '@/lib/hybrid-sync/sync-state'

export async function GET(req: NextRequest) {
  try {
    const auth = await requireSessionOrDevice(req, ['settings'])
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const snapshot = await buildHealthSnapshot()

    // server-side best-effort internet verdict from the last cloud contact:
    // reachable → online; unreachable and checked recently → offline; else unknown
    let internet: 'online' | 'offline' | 'unknown' = 'unknown'
    const reachable = await getState(STATE_CLOUD_REACHABLE)
    const lastCheckedAt = await getState(STATE_CLOUD_LAST_CHECKED)
    if (reachable === 'yes') {
      internet = 'online'
    } else if (reachable === 'no' && lastCheckedAt) {
      const ms = Date.parse(lastCheckedAt)
      internet = Number.isFinite(ms) && Date.now() - ms < 2 * 60_000 ? 'offline' : 'unknown'
    }

    return NextResponse.json({ ...snapshot, internet })
  } catch (err) {
    return errorResponse(err)
  }
}
