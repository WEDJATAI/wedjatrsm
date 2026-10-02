// /api/vision/tables/[id]/override — manual override of a table's
// observational state (floor staff: waiter / admin / pos / vision).
// Confidence 1 (human evidence) + a manual hold freezing AI display state.

import { NextRequest, NextResponse } from 'next/server'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { parseId } from '@/lib/orders'
import { overrideTableState } from '@/lib/vision'

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const user = await requireAuth(req, ['waiter', 'admin', 'pos', 'vision'])
    const { id } = await ctx.params
    const tableId = parseId(id, 'table id')
    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })

    const state = body?.state
    if (state !== 'occupied' && state !== 'empty') {
      throw new ApiError("state must be 'occupied' or 'empty'", 400)
    }
    let peopleCount: number | undefined
    if (body?.peopleCount != null) {
      const n = Number(body.peopleCount)
      if (!Number.isInteger(n) || n < 0 || n > 50) {
        throw new ApiError('peopleCount must be an integer between 0 and 50', 400)
      }
      peopleCount = n
    }
    let reason: string | undefined
    if (body?.reason != null) {
      if (typeof body.reason !== 'string' || body.reason.length > 200) {
        throw new ApiError('reason must be a string of at most 200 characters', 400)
      }
      reason = body.reason.trim() || undefined
    }

    const visionState = await overrideTableState(user, tableId, state, peopleCount, reason)
    return NextResponse.json({ state: visionState })
  } catch (err) {
    return errorResponse(err)
  }
}
