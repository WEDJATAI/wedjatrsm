// /api/hybrid/sync-now — R30 manual sync trigger (admin).
//
// Runs one push cycle + one pull cycle immediately. If a cycle is already
// running (engine tick or a concurrent manual trigger) the route answers
// 409 instead of queueing a second run.
import { NextRequest, NextResponse } from 'next/server'

import { errorResponse, requireAuth } from '@/lib/auth'
import { triggerHybridSyncNow } from '@/lib/hybrid-sync/hybrid-engine'

export async function POST(req: NextRequest) {
  try {
    await requireAuth(req, ['settings'])
    const result = await triggerHybridSyncNow()
    if (result.busy) {
      return NextResponse.json({ error: 'sync already running' }, { status: 409 })
    }
    return NextResponse.json({
      push: { pushed: result.push.pushed, acked: result.push.acked, failed: result.push.failed },
      pull: {
        applied: result.pull.applied,
        skipped: result.pull.skipped,
        conflicts: result.pull.conflicts,
        failed: result.pull.failed,
        remaining: result.pull.remaining,
      },
    })
  } catch (err) {
    return errorResponse(err)
  }
}
