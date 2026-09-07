// /api/orders/[id]/defer — defer payment of a check with the client's
// name (waiter/admin). The order moves to status 'deferred' (client pays
// later); its tables switch to 'deferred' (tap-to-clear after cleanup).

import { NextRequest, NextResponse } from 'next/server'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { deferOrder, parseId, serializeOrder } from '@/lib/orders'

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    await requireAuth(req, ['waiter', 'admin', 'pos'])
    const { id } = await ctx.params
    const orderId = parseId(id, 'order id')

    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })
    const clientName = String(body?.clientName ?? '').trim()
    if (clientName.length < 1 || clientName.length > 60) {
      throw new ApiError('Client name is required (1-60 characters)', 400)
    }

    const updated = await deferOrder(orderId, clientName)
    return NextResponse.json({ order: serializeOrder(updated) })
  } catch (err) {
    return errorResponse(err)
  }
}
