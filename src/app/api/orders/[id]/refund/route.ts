// /api/orders/[id]/refund — R17: refund issuance against a PAID check.
//
// Design (Foodics-style, zero schema change): a refund is a NEGATIVE Payment
// row (amount < 0) with reference `refund: <reason>`. This keeps the ledger
// honest everywhere it is already aggregated:
//   · serializeOrder paidAmount = Σ payments → net paid drops automatically
//   · Z-report paymentsByMethod nets cash/card for the refund DAY (the drawer
//     the money left from) — refunds are aggregated explicitly too (refunds.total)
//   · the R15 sync engine ships payments one-way — refund rows sync as-is
//
// Rules: admin-only (manager-level action in Foodics); order must be 'paid';
// cumulative refunds may never exceed what was actually paid; reason required
// (audit trail); partial refunds allowed; multiple refunds allowed.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, errorResponse, ApiError } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { round2, serializeOrder, ORDER_INCLUDE } from '@/lib/orders'

const METHODS = ['cash', 'card', 'other']
const REASON_MAX = 140

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    // Refunds are a manager action — classic admin role only (custom roles
    // have no dedicated refund permission; documented in the worklog).
    const session = await requireAuth(req, ['admin'])
    const { id } = await ctx.params
    const orderId = Number(id)
    if (!Number.isInteger(orderId) || orderId <= 0) throw new ApiError('Invalid order id', 400)

    const body = (await req.json().catch(() => null)) as {
      amount?: unknown
      reason?: unknown
      method?: unknown
    } | null

    const amount = round2(Number(body?.amount))
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new ApiError('Refund amount must be greater than 0', 400)
    }
    const reason = String(body?.reason ?? '').trim()
    if (!reason) throw new ApiError('A refund reason is required (audit trail)', 400)
    if (reason.length > REASON_MAX) {
      throw new ApiError(`Reason too long (max ${REASON_MAX} chars)`, 400)
    }
    const method = body?.method == null ? null : String(body?.method)
    if (method !== null && !METHODS.includes(method)) {
      throw new ApiError(`Invalid method — expected one of ${METHODS.join('/')}`, 400)
    }

    const order = await db.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE })
    if (!order) throw new ApiError('Order not found', 404)
    if (order.status !== 'paid') {
      throw new ApiError('Only paid (closed) orders can be refunded', 409)
    }

    // Refund capacity: what was actually paid minus what was already refunded.
    let paidTotal = 0
    let refundedTotal = 0
    for (const p of order.payments) {
      if (p.amount >= 0) paidTotal += p.amount
      else refundedTotal += -p.amount
    }
    const capacity = round2(paidTotal - refundedTotal)
    if (round2(amount) > capacity) {
      throw new ApiError(
        `Refund exceeds refundable amount (${capacity.toFixed(2)} EGP remaining of ${round2(paidTotal).toFixed(2)} paid)`,
        400,
      )
    }

    // Default method: how the largest original payment was tendered.
    const refundMethod =
      method ??
      (order.payments.filter((p) => p.amount > 0).sort((a, b) => b.amount - a.amount)[0]?.method ??
        'cash')

    const [payment] = await db.$transaction([
      db.payment.create({
        data: {
          orderId,
          method: refundMethod,
          amount: -round2(amount),
          tip: 0,
          reference: `refund: ${reason}`,
        },
      }),
    ])

    // Fire-and-forget audit trail (never blocks the business operation).
    await logAudit({
      user: session,
      action: 'order.refund',
      entity: 'order',
      entityId: orderId,
      details: `#${orderId} −${round2(amount).toFixed(2)} EGP (${refundMethod}) — ${reason}`,
    })

    const updated = await db.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE })
    return NextResponse.json({
      order: updated ? serializeOrder(updated) : null,
      refund: { paymentId: payment.id, amount: round2(amount), method: refundMethod, reason },
      refundedTotal: round2(refundedTotal + amount),
      remainingCapacity: round2(capacity - amount),
    })
  } catch (err) {
    return errorResponse(err)
  }
}
