// /api/orders/[id]/payments — record (split) payments (waiter/admin)

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { MONEY_EPSILON, PAYMENT_METHODS } from '@/lib/constants'
import { redeemLoyaltyPoints } from '@/lib/loyalty'
import { paymentReference } from '@/lib/payment'
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
    // R13: a loyalty-only POST (redeemPoints with an empty payments array)
    // is allowed — the POS redeem chip sends exactly that.
    const loyaltyOnly = body?.redeemPoints != null && Array.isArray(payments) && payments.length === 0
    if ((!Array.isArray(payments) || payments.length === 0) && !loyaltyOnly) {
      throw new ApiError('payments must be a non-empty array', 400)
    }

    type ParsedRow = {
      method: string
      amount: number
      tip: number
      reference: string | null
      amountTendered: number
      changeGiven: number
    }
    const rows: ParsedRow[] = []
    const now = new Date()
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
      // ── R26 Payment Pro: cash-received / change-back flow ──
      // `amount` stays the BILL portion (never over the remaining balance);
      // `amountTendered` records what the guest handed over and `changeGiven`
      // what went back out of the drawer (the difference may instead flow
      // into `tip` when the waiter taps "add to tip").
      const amountTendered = raw?.amountTendered == null ? 0 : Number(raw.amountTendered)
      if (!Number.isFinite(amountTendered) || amountTendered < 0) {
        throw new ApiError('Amount received must be zero or greater', 400)
      }
      const changeGiven = raw?.changeGiven == null ? 0 : Number(raw.changeGiven)
      if (!Number.isFinite(changeGiven) || changeGiven < 0) {
        throw new ApiError('Change given must be zero or greater', 400)
      }
      if (amountTendered > 0 && amountTendered + MONEY_EPSILON < amount) {
        throw new ApiError('Amount received cannot be less than the payment amount', 400)
      }
      if (changeGiven > 0 && changeGiven > round2(amountTendered - amount) + MONEY_EPSILON) {
        throw new ApiError('Change given cannot exceed the amount received over the bill', 400)
      }
      rows.push({
        method,
        amount,
        tip: round2(tip),
        // R26: every POS payment gets an automatic reference — timestamp +
        // payment-type code (e.g. CASH-20260215-143205-K7M). Printed on the
        // receipt; the audit trail and drawer ledger key off it.
        reference: paymentReference(method, now),
        amountTendered: round2(amountTendered),
        changeGiven: round2(changeGiven),
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

    // R13: loyalty redemption — points converted to tender BEFORE the
    // regular rows are recorded. The redemption caps itself at the remaining
    // balance NET of the regular rows in this same request, so a combined
    // call splits the bill and can never overshoot it.
    if (body?.redeemPoints != null) {
      const points = Number(body.redeemPoints)
      if (!Number.isFinite(points) || points <= 0) {
        throw new ApiError('redeemPoints must be greater than zero', 400)
      }
      const reserve = round2(rows.reduce((sum, p) => sum + p.amount, 0))
      const redemption = await redeemLoyaltyPoints(orderId, points, reserve)
      await logAudit({
        user,
        action: 'loyalty.redeem',
        entity: 'payment',
        entityId: orderId,
        details: `Order #${orderId}: ${redemption.customerName} redeemed points worth EGP ${redemption.egpValue.toFixed(2)}`,
      })
    }

    // Snapshot: was this check deferred BEFORE these payments? (a deferred
    // check that this payment fully settles gets its own audit entry)
    const wasDeferred = order.status === 'deferred'

    // R19: paying = the check was definitely presented — stamp the PERSON
    // who issued it when nobody stamped earlier (first issuance wins; an
    // account-level session doesn't burn the stamp slot).
    if (order.checkIssuedByPersonId == null && user.personId != null) {
      await db.order.updateMany({
        where: { id: orderId, checkIssuedByPersonId: null },
        data: {
          checkIssuedByPersonId: user.personId,
          checkIssuedAt: new Date(),
        },
      })
    }

    await db.payment.createMany({
      data: rows.map((p) => ({
        orderId,
        method: p.method,
        amount: p.amount,
        tip: p.tip,
        reference: p.reference,
        amountTendered: p.amountTendered,
        changeGiven: p.changeGiven,
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
            `${p.method} ${round2(p.amount).toFixed(2)} [${p.reference}]${
              p.tip > 0 ? ` (tip EGP ${round2(p.tip).toFixed(2)})` : ''
            }${
              p.amountTendered > 0
                ? ` (received EGP ${round2(p.amountTendered).toFixed(2)}` +
                  (p.changeGiven > 0 ? `, change EGP ${round2(p.changeGiven).toFixed(2)}` : '') +
                  ')'
                : ''
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
