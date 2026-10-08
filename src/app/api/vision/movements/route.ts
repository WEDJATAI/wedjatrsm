// /api/vision/movements — AI-detected movement candidates (floor staff)
// Query: ?status=pending|confirmed|rejected|conflict|expired|all (default pending)

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { MOVEMENT_INCLUDE, serializeMovementsWithOrders } from '@/lib/vision'

const STATUS_FILTERS = ['pending', 'confirmed', 'rejected', 'conflict', 'expired', 'all']

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['waiter', 'admin', 'pos', 'vision'])
    const status = new URL(req.url).searchParams.get('status') ?? 'pending'
    if (!STATUS_FILTERS.includes(status)) {
      throw new ApiError(`Invalid status filter "${status}"`, 400)
    }
    const movements = await db.movementCandidate.findMany({
      where: status === 'all' ? {} : { status },
      include: MOVEMENT_INCLUDE,
      orderBy: { detectedAt: 'desc' },
      take: 200,
    })
    return NextResponse.json({ movements: await serializeMovementsWithOrders(movements) })
  } catch (err) {
    return errorResponse(err)
  }
}
