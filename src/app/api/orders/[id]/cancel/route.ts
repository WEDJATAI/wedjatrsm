// /api/orders/[id]/cancel — cancel an order (admin OR the creating waiter)

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import {
  ORDER_INCLUDE,
  freeTableIfUnused,
  getOrderOr404,
  parseId,
  serializeOrder,
  sessionUserId,
} from '@/lib/orders'

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const session = await requireAuth(req) // role checked manually below
    const { id } = await ctx.params
    const orderId = parseId(id, 'order id')

    const order = await getOrderOr404(orderId)
    if (session.role !== 'admin' && order.userId !== sessionUserId(session)) {
      throw new ApiError('Only an admin or the waiter who created this order can cancel it', 403)
    }
    if (order.status === 'paid') {
      throw new ApiError('Cannot cancel a paid order', 400)
    }
    if (order.status === 'cancelled') {
      throw new ApiError('Order is already cancelled', 400)
    }

    const updated = await db.order.update({
      where: { id: orderId },
      data: { status: 'cancelled', closedAt: new Date() },
      include: ORDER_INCLUDE,
    })

    // Release the table (only when no other open order uses it).
    // Cancelled orders make NO inventory changes.
    if (order.tableId != null) {
      await freeTableIfUnused(order.tableId, orderId)
    }

    return NextResponse.json({ order: serializeOrder(updated) })
  } catch (err) {
    return errorResponse(err)
  }
}
