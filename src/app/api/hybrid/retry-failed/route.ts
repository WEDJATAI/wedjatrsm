// /api/hybrid/retry-failed — R30 admin queue repair.
//
// Resets failed (and optionally dead) OUTBOUND events back to 'pending' so
// the next engine cycle retries them immediately — the "try again now"
// button after an outage or a fixed device-auth problem.
import { NextRequest, NextResponse } from 'next/server'

import { errorResponse, requireAuth } from '@/lib/auth'
import { db } from '@/lib/db'

export async function POST(req: NextRequest) {
  try {
    await requireAuth(req, ['settings'])
    const body: { includeDead?: unknown } = await req.json().catch(() => ({}) as { includeDead?: unknown })
    const statuses: string[] = ['failed']
    if (body.includeDead === true) statuses.push('dead')

    const result = await db.hybridEvent.updateMany({
      where: { direction: 'out', status: { in: statuses } },
      data: { status: 'pending', nextAttemptAt: new Date(), lastError: null },
    })

    return NextResponse.json({ reset: result.count })
  } catch (err) {
    return errorResponse(err)
  }
}
