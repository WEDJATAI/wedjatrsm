// /api/vision/movements/[id]/confirm — human confirmation of an AI movement
// (floor staff: waiter / admin / pos / vision). mode 'table_and_order'
// re-houses the open order with the exact POS transfer semantics.

import { NextRequest, NextResponse } from 'next/server'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { parseId } from '@/lib/orders'
import { confirmMovement } from '@/lib/vision'

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const user = await requireAuth(req, ['waiter', 'admin', 'pos', 'vision'])
    const { id } = await ctx.params
    const movementId = parseId(id, 'movement id')
    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })

    const mode = body?.mode
    if (mode !== 'table_and_order' && mode !== 'table_only') {
      throw new ApiError("mode must be 'table_and_order' or 'table_only'", 400)
    }
    let reason: string | undefined
    if (body?.reason != null) {
      if (typeof body.reason !== 'string' || body.reason.length > 200) {
        throw new ApiError('reason must be a string of at most 200 characters', 400)
      }
      reason = body.reason.trim() || undefined
    }

    const result = await confirmMovement(user, movementId, mode, reason)
    const payload: Record<string, unknown> = { movement: result.movement }
    if (result.order) payload.order = result.order
    return NextResponse.json(payload)
  } catch (err) {
    return errorResponse(err)
  }
}
