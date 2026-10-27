// /api/hybrid/pause — R30 pause/resume the background engine (admin).
//
// While paused, the engine tick skips both cycles (business writes still
// accumulate in the outbox — nothing is lost, sync resumes where it stopped).
import { NextRequest, NextResponse } from 'next/server'

import { errorResponse, ApiError, requireAuth } from '@/lib/auth'
import { setState, getState, STATE_SYNC_PAUSED } from '@/lib/hybrid-sync/sync-state'

export async function POST(req: NextRequest) {
  try {
    await requireAuth(req, ['settings'])
    const body: { paused?: unknown } = await req.json().catch(() => ({}) as { paused?: unknown })
    if (typeof body.paused !== 'boolean') {
      throw new ApiError('paused (boolean) is required', 400)
    }
    await setState(STATE_SYNC_PAUSED, body.paused ? '1' : '0')
    const paused = (await getState(STATE_SYNC_PAUSED)) === '1'
    return NextResponse.json({ paused })
  } catch (err) {
    return errorResponse(err)
  }
}
