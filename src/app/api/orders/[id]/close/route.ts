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
    await requireAuth(req, ['waiter', 'admin', 'pos'])
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

    await closeOrderIfFullyPaid(orderId)
    const fresh = await getOrderOr404(orderId)
    return NextResponse.json({ order: serializeOrder(fresh), closed: true })
  } catch (err) {
    return errorResponse(err)
  }
}
