// /api/orders/[id]/tip — record a gratuity AFTER the check was settled.
//
// r54 Guided Checkout: the real-world cashier sequence is print invoice →
// take the money → return change → hand the PAID invoice → the guest leaves
// a tip on the table → the cashier records it. Tips attached at tender time
// (R8 payment rows / R26 keep-the-change) already exist; this endpoint
// covers the LAST mile — money left behind AFTER settlement:
//   · authorization: any signed-in waiter/admin/pos session (same as payments)
//   · the tip is ADDED to the order's most recent payment row (idempotent
//     with R8/R26: all three paths aggregate through Payment.tip, so
//     receipts, Z-reports, payroll and per-server tips stay consistent)
//   · `amount` is the tip the cashier is holding (> 0, sane cap)
//   · allowed while the check is open/deferred/paid — terminal statuses
//     (cancelled/revoked/merged) refuse
//   · the write rides the R30 outbox (Payment update + Order update in ONE
//     transaction, local ↔ cloud parity) + a dedicated audit row
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { emitOutboxEvent } from '@/lib/hybrid-sync/outbox'
import { getOrderOr404, parseId, round2, serializeOrder } from '@/lib/orders'

type Ctx = { params: Promise<{ id: string }> }

/** Sanity cap for a single tip recording (EGP) — anything above is a typo. */
const TIP_MAX = 100_000

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
    if (!['open', 'deferred', 'paid'].includes(order.status)) {
      throw new ApiError('Tips can only be recorded on open, deferred or paid checks', 400)
    }
    // The tip lands on a payment row — a check with no payment has no tip slot.
    if (order.payments.length === 0) {
      throw new ApiError('This check has no payment to attach a tip to', 400)
    }

    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })
    const amount = Number(body?.amount)
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ApiError('Tip amount must be greater than zero', 400)
    }
    if (amount > TIP_MAX) {
      throw new ApiError(`Tip amount is unrealistically large (max EGP ${TIP_MAX})`, 400)
    }

    // Most recent payment row on this check — the one the guest just settled.
    const target = [...order.payments].sort((a, b) => b.id - a.id)[0]
    const prevTip = round2(target.tip ?? 0)
    const newTip = round2(prevTip + round2(amount))

    const updatedPayment = await db.$transaction(async (tx) => {
      const payment = await tx.payment.update({
        where: { id: target.id },
        data: { tip: newTip },
      })
      await emitOutboxEvent(tx, {
        entity: 'Payment',
        entityId: payment.id,
        operation: 'update',
        row: payment,
      })
      const orderRow = await tx.order.update({
        where: { id: orderId },
        data: { updatedAt: new Date() },
      })
      await emitOutboxEvent(tx, {
        entity: 'Order',
        entityId: orderId,
        operation: 'update',
        row: orderRow,
      })
      return payment
    })

    const tipsTotal = round2(
      newTip +
        order.payments.filter((p) => p.id !== target.id).reduce((s, p) => s + (p.tip ?? 0), 0),
    )

    await logAudit({
      user,
      action: 'order.tip',
      entity: 'order',
      entityId: orderId,
      details: `EGP ${round2(amount).toFixed(2)} tip added to payment #${updatedPayment.id}${
        updatedPayment.reference ? ` [${updatedPayment.reference}]` : ''
      } on order #${orderId} — tips on this check now EGP ${tipsTotal.toFixed(2)}`,
    })

    const fresh = await getOrderOr404(orderId)
    return NextResponse.json({
      order: serializeOrder(fresh),
      tip: round2(amount),
      paymentId: updatedPayment.id,
      tipsTotal,
    })
  } catch (err) {
    return errorResponse(err)
  }
}
