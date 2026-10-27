// /api/vision/movements/[id]/reject — reject a pending AI movement
// (floor staff: waiter / admin / pos / vision)

import { NextRequest, NextResponse } from 'next/server'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { parseId } from '@/lib/orders'
import { rejectMovement } from '@/lib/vision'

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const user = await requireAuth(req, ['waiter', 'admin', 'pos', 'vision'])
    const { id } = await ctx.params
    const movementId = parseId(id, 'movement id')
    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })

    let reason: string | undefined
    if (body?.reason != null) {
      if (typeof body.reason !== 'string' || body.reason.length > 200) {
        throw new ApiError('reason must be a string of at most 200 characters', 400)
      }
      reason = body.reason.trim() || undefined
    }

    const result = await rejectMovement(user, movementId, reason)
    return NextResponse.json({ movement: result.movement })
  } catch (err) {
    return errorResponse(err)
  }
}
