// /api/vision/movements/[id]/undo — revert a confirmed & applied movement
// (floor staff: waiter / admin / pos / vision). Never forces a conflicting
// state — 409 with a clear message instead.

import { NextRequest, NextResponse } from 'next/server'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { parseId } from '@/lib/orders'
import { undoMovement } from '@/lib/vision'

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

    const result = await undoMovement(user, movementId, reason)
    const payload: Record<string, unknown> = { movement: result.movement }
    if (result.order) payload.order = result.order
    return NextResponse.json(payload)
  } catch (err) {
    return errorResponse(err)
  }
}
