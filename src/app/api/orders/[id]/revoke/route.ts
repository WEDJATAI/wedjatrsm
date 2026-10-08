// /api/orders/[id]/revoke — revoke a payment AFTER it was made.
//
// Terminal void of a paid check, zero schema change (Order.status is a free
// String — 'revoked' joins 'open'|'paid'|'cancelled'|'merged'|'deferred'):
//   · authorization: the CASHIER'S OWN 6-digit PIN (users.pin — the same PIN
//     used for employee check-in). Any active staff account with that PIN
//     authorizes; the session user + the PIN user are both recorded.
//   · a reason is REQUIRED (≤140 chars, audit trail)
//   · the money is reversed as ONE negative Payment row (reference
//     `revoke: <reason>`), exactly like refunds — so every aggregation
//     (paidAmount, Z-report, net payments by method) stays honest
//   · the order flips to status 'revoked' (terminal — refund/cancel/revoke
//     all refuse to touch it afterwards)
//   · tables stay 'paid' → the normal bussing flow continues
//   · the write rides the R30 outbox (local ↔ cloud parity), same as refunds
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, errorResponse, ApiError } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { emitOutboxEvent } from '@/lib/hybrid-sync/outbox'
import { round2, serializeOrder, ORDER_INCLUDE } from '@/lib/orders'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'
import { PIN_LENGTH, MONEY_EPSILON } from '@/lib/constants'

const REASON_MAX = 140

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    // any signed-in staff member may initiate; the cashier PIN is the authority
    const session = await requireAuth(req)
    const { id } = await ctx.params
    const orderId = Number(id)
    if (!Number.isInteger(orderId) || orderId <= 0) throw new ApiError('Invalid order id', 400)

    // brute-force guard: 10 attempts / 5 min per IP+order
    const rlKey = `revoke:${clientIp(req)}:${orderId}`
    const rl = checkRateLimit(rlKey, 10, 5 * 60_000)
    if (!rl.ok) {
      throw new ApiError(`Too many attempts — try again in ${rl.retryAfterSec}s`, 429)
    }

    const body = (await req.json().catch(() => null)) as { pin?: unknown; reason?: unknown } | null
    const pin = String(body?.pin ?? '').trim()
    if (!new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)) {
      throw new ApiError(`A ${PIN_LENGTH}-digit cashier PIN is required`, 400)
    }
    const reason = String(body?.reason ?? '').trim()
    if (!reason) throw new ApiError('A revoke reason is required (audit trail)', 400)
    if (reason.length > REASON_MAX) {
      throw new ApiError(`Reason too long (max ${REASON_MAX} chars)`, 400)
    }

    // cashier PIN authorization — an active staff account with this exact PIN
    const pinUser = await db.user.findFirst({ where: { pin, active: true } })
    if (!pinUser) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      throw new ApiError('Invalid cashier PIN', 401)
    }

    const order = await db.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE })
    if (!order) throw new ApiError('Order not found', 404)
    if (order.status !== 'paid') {
      throw new ApiError('Only paid orders can be revoked', 409)
    }

    // reversible amount: what was actually paid minus what was already
    // refunded/revoked (negative payments) — the revoke reverses ALL of it.
    let paidTotal = 0
    let refundedTotal = 0
    for (const p of order.payments) {
      if (p.amount >= 0) paidTotal += p.amount
      else refundedTotal += -p.amount
    }
    const capacity = round2(paidTotal - refundedTotal)
    if (capacity <= MONEY_EPSILON) {
      throw new ApiError('Nothing left to revoke — this check was already fully reversed', 409)
    }

    // default method: how the largest original payment was tendered
    const method =
      order.payments.filter((p) => p.amount > 0).sort((a, b) => b.amount - a.amount)[0]?.method ?? 'cash'

    // R30 hybrid sync: the negative payment + the order status flip + their
    // outbox events commit in ONE transaction (refund route pattern).
    const [payment] = await db.$transaction(async (tx) => {
      const createdPayment = await tx.payment.create({
        data: {
          orderId,
          method,
          amount: -capacity,
          tip: 0,
          reference: `revoke: ${reason}`,
        },
      })
      await emitOutboxEvent(tx, {
        entity: 'Payment',
        entityId: createdPayment.id,
        operation: 'create',
        row: createdPayment,
      })
      const revokedOrder = await tx.order.update({
        where: { id: orderId },
        data: { status: 'revoked' },
      })
      await emitOutboxEvent(tx, {
        entity: 'Order',
        entityId: orderId,
        operation: 'update',
        row: revokedOrder,
      })
      return [createdPayment] as const
    })

    // fire-and-forget audit trail (session user + PIN authorizer + reason)
    await logAudit({
      user: session,
      action: 'order.revoke',
      entity: 'order',
      entityId: orderId,
      details: `#${orderId} payment revoked (−${capacity.toFixed(2)} EGP, ${method}) — authorized by ${pinUser.name} (cashier PIN) — ${reason}`,
    })

    const updated = await db.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE })
    return NextResponse.json({
      order: updated ? serializeOrder(updated) : null,
      revoke: {
        paymentId: payment.id,
        amount: capacity,
        method,
        reason,
        revokedBy: pinUser.name,
      },
    })
  } catch (err) {
    return errorResponse(err)
  }
}
