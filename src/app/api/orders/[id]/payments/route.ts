// /api/orders/[id]/payments — record (split) payments (waiter/admin)

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { MONEY_EPSILON, PAYMENT_METHODS } from '@/lib/constants'
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
    await requireAuth(req, ['waiter', 'admin'])
    const { id } = await ctx.params
    const orderId = parseId(id, 'order id')

    const order = await db.order.findUnique({
      where: { id: orderId },
      include: { payments: true },
    })
    if (!order) throw new ApiError('Order not found', 404)
    if (order.status !== 'open') {
      throw new ApiError('Only open orders can receive payments', 400)
    }

    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })
    const payments = body?.payments
    if (!Array.isArray(payments) || payments.length === 0) {
      throw new ApiError('payments must be a non-empty array', 400)
    }

    const rows: { method: string; amount: number; reference: string | null }[] = []
    for (const raw of payments) {
      const method = String(raw?.method ?? '')
      if (!(PAYMENT_METHODS as readonly string[]).includes(method)) {
        throw new ApiError(`Invalid payment method "${method}"`, 400)
      }
      const amount = Number(raw?.amount)
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new ApiError('Payment amounts must be greater than zero', 400)
      }
      rows.push({
        method,
        amount,
        reference: raw?.reference == null ? null : String(raw.reference),
      })
    }

    const paidAmount = order.payments.reduce((sum, p) => sum + p.amount, 0)
    const newPaid = paidAmount + rows.reduce((sum, p) => sum + p.amount, 0)
    if (newPaid > order.totalAmount + MONEY_EPSILON) {
      const remaining = round2(order.totalAmount - paidAmount)
      throw new ApiError(
        `Payment exceeds the remaining balance (EGP ${remaining.toFixed(2)})`,
        400,
      )
    }

    await db.payment.createMany({
      data: rows.map((p) => ({
        orderId,
        method: p.method,
        amount: p.amount,
        reference: p.reference,
      })),
    })

    const { closed } = await closeOrderIfFullyPaid(orderId)

    const fresh = await getOrderOr404(orderId)
    const serialized = serializeOrder(fresh)
    return NextResponse.json({
      order: serialized,
      paidAmount: serialized.paidAmount,
      remaining: serialized.remainingAmount,
      closed,
    })
  } catch (err) {
    return errorResponse(err)
  }
}
