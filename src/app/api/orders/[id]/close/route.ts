// /api/orders/[id]/close — force-close a fully paid order (waiter/admin)

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { MONEY_EPSILON } from '@/lib/constants'
import {
  closeOrderIfFullyPaid,
  getOrderOr404,
  parseId,
  round2,
  serializeOrder,
} from '@/lib/orders'

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const user = await requireAuth(req, ['waiter', 'admin', 'pos'])
    const { id } = await ctx.params
    const orderId = parseId(id, 'order id')

    const order = await db.order.findUnique({
      where: { id: orderId },
      include: { payments: true },
    })
    if (!order) throw new ApiError('Order not found', 404)

    const paidAmount = order.payments.reduce((sum, p) => sum + p.amount, 0)
    const remaining = round2(order.totalAmount - paidAmount)
    if (remaining > MONEY_EPSILON) {
      throw new ApiError(
        `Order is not fully paid yet (remaining EGP ${remaining.toFixed(2)})`,
        400,
      )
    }

    // r68: SETTLE-CLAIM (same rule as the payments route) — force-closing a
    // fully-paid check that was OPENED BEFORE TODAY by a different server
    // makes it the closing server's shift work. This is the organic recovery
    // path for cross-plane stuck checks (paid on another terminal, stuck
    // open here): whoever closes it gets it in their My shift.
    if (order.userId != null && order.userId !== user.userId) {
      const now = new Date()
      const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      if (order.createdAt < dayStart) {
        await db.order.updateMany({
          where: { id: orderId, userId: order.userId },
          data: { userId: user.userId },
        })
      }
    }

    await closeOrderIfFullyPaid(orderId)
    const fresh = await getOrderOr404(orderId)
    return NextResponse.json({ order: serializeOrder(fresh), closed: true })
  } catch (err) {
    return errorResponse(err)
  }
}
