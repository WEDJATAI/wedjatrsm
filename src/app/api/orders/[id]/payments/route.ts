// /api/orders/[id]/payments — record (split) payments (waiter/admin)

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
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
    const user = await requireAuth(req, ['waiter', 'admin', 'pos'])
    const { id } = await ctx.params
    const orderId = parseId(id, 'order id')

    const order = await db.order.findUnique({
      where: { id: orderId },
      include: { payments: true },
    })
    if (!order) throw new ApiError('Order not found', 404)
    if (order.status !== 'open' && order.status !== 'deferred') {
      throw new ApiError('Only open or deferred orders can receive payments', 400)
    }

    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })
    const payments = body?.payments
    if (!Array.isArray(payments) || payments.length === 0) {
      throw new ApiError('payments must be a non-empty array', 400)
    }

    const rows: { method: string; amount: number; tip: number; reference: string | null }[] = []
    for (const raw of payments) {
      const method = String(raw?.method ?? '')
      if (!(PAYMENT_METHODS as readonly string[]).includes(method)) {
        throw new ApiError(`Invalid payment method "${method}"`, 400)
      }
      const amount = Number(raw?.amount)
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new ApiError('Payment amounts must be greater than zero', 400)
      }
      // R8: optional gratuity ON TOP of the bill. Persisted on the payment
      // row but NEVER counted toward paidAmount / the close-if-fully-paid
      // check (that logic sums `amount` only, untouched below).
      const tip = raw?.tip == null ? 0 : Number(raw.tip)
      if (!Number.isFinite(tip) || tip < 0) {
        throw new ApiError('Payment tips must be zero or greater', 400)
      }
      rows.push({
        method,
        amount,
        tip: round2(tip),
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

    // Snapshot: was this check deferred BEFORE these payments? (a deferred
    // check that this payment fully settles gets its own audit entry)
    const wasDeferred = order.status === 'deferred'

    await db.payment.createMany({
      data: rows.map((p) => ({
        orderId,
        method: p.method,
        amount: p.amount,
        tip: p.tip,
        reference: p.reference,
      })),
    })

    const { closed } = await closeOrderIfFullyPaid(orderId)

    await logAudit({
      user,
      action: 'order.payment',
      entity: 'order',
      entityId: orderId,
      details: `EGP ${round2(rows.reduce((sum, p) => sum + p.amount, 0)).toFixed(2)} (${rows
        .map(
          (p) =>
            `${p.method} ${round2(p.amount).toFixed(2)}${
              p.tip > 0 ? ` (tip EGP ${round2(p.tip).toFixed(2)})` : ''
            }`,
        )
        .join(', ')}) on order #${orderId}${closed ? ' — closed' : ''}`,
    })
    if (wasDeferred && closed) {
      await logAudit({
        user,
        action: 'order.deferSettle',
        entity: 'order',
        entityId: orderId,
        details: `Deferred check #${orderId} (client ${order.clientName ?? '—'}) settled — EGP ${round2(
          rows.reduce((sum, p) => sum + p.amount, 0),
        ).toFixed(2)} received`,
      })
    }

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
