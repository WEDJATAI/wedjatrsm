// /api/orders/[id]/cancel — cancel an order.
//
// Open / deferred orders: admin OR the creating waiter (unchanged behavior).
//
// r65 — CANCEL AFTER THE CHECK IS CLOSED: a PAID order can now be cancelled,
// but ONLY by a manager or the developer (admin / developer / super admin)
// AND only with the 6-digit DEVELOPER PIN in the body ({ pin }). The money
// that changed hands is reversed honestly as ONE negative Payment row
// (reference `cancel-after-close: order #N` — exactly the revoke/refund
// pattern), so every aggregation (paidAmount, Z-report, net-by-method)
// stays truthful. Inventory is NOT restored (same documented trade-off as
// revoke). 'revoked' orders are terminal — nothing can cancel them.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth, verifyDeveloperPin } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { emitOutboxEvent } from '@/lib/hybrid-sync/outbox'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'
import { MONEY_EPSILON } from '@/lib/constants'
import {
  ORDER_INCLUDE,
  freeTableIfUnused,
  getOrderOr404,
  orderTableIds,
  parseId,
  round2,
  serializeOrder,
  sessionUserId,
} from '@/lib/orders'

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const session = await requireAuth(req) // role checked manually below
    const { id } = await ctx.params
    const orderId = parseId(id, 'order id')

    const body = (await req.json().catch(() => null)) as { pin?: unknown } | null

    const order = await getOrderOr404(orderId)
    // r31 audit fix: the developer role is admin-equivalent by design (p11-d)
    // — a manual `role !== 'admin'` check locked the developer out of
    // cancelling anyone's orders. Use isSuperAdmin OR developer OR admin.
    const privileged =
      session.role === 'admin' || session.role === 'developer' || session.isSuperAdmin === true

    // ── r65: paid (closed) checks — manager/developer only + developer PIN ──
    if (order.status === 'paid') {
      if (!privileged) {
        throw new ApiError(
          'Only a manager or the developer can cancel a closed (paid) check',
          403,
        )
      }
      // brute-force guard: 10 attempts / 5 min per IP+order (revoke pattern)
      const rlKey = `cancel-paid:${clientIp(req)}:${orderId}`
      const rl = checkRateLimit(rlKey, 10, 5 * 60_000)
      if (!rl.ok) {
        throw new ApiError(`Too many attempts — try again in ${rl.retryAfterSec}s`, 429)
      }
      const pin = String(body?.pin ?? '').trim()
      if (!/^\d{6}$/.test(pin)) {
        throw new ApiError('The developer PIN is required to cancel a closed check', 400)
      }
      if (!(await verifyDeveloperPin(pin))) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        throw new ApiError('Wrong PIN — closed-check cancel denied', 403)
      }

      // reversible amount: what was actually paid minus what was already
      // refunded/revoked (negative payments) — cancelled as ONE negative row.
      let paidTotal = 0
      let refundedTotal = 0
      for (const p of order.payments) {
        if (p.amount >= 0) paidTotal += p.amount
        else refundedTotal += -p.amount
      }
      const capacity = round2(paidTotal - refundedTotal)
      const method =
        order.payments.filter((p) => p.amount > 0).sort((a, b) => b.amount - a.amount)[0]?.method ??
        'cash'

      // R30 hybrid sync: the compensating payment (when any) + the status
      // flip + their outbox events commit in ONE transaction.
      const updated = await db.$transaction(async (tx) => {
        if (capacity > MONEY_EPSILON) {
          const createdPayment = await tx.payment.create({
            data: {
              orderId,
              method,
              amount: -capacity,
              tip: 0,
              reference: `cancel-after-close: order #${orderId}`,
            },
          })
          await emitOutboxEvent(tx, {
            entity: 'Payment',
            entityId: createdPayment.id,
            operation: 'create',
            row: createdPayment,
          })
        }
        const saved = await tx.order.update({
          where: { id: orderId },
          data: { status: 'cancelled' },
          include: ORDER_INCLUDE,
        })
        const orderRow = await tx.order.findUnique({ where: { id: orderId } })
        if (orderRow) {
          await emitOutboxEvent(tx, {
            entity: 'Order',
            entityId: orderId,
            operation: 'update',
            row: orderRow,
          })
        }
        return saved
      })

      // Release EVERY seating table (primary + merged extras) — only when no
      // other open order uses them (a paid check's tables sit in 'paid'
      // awaiting bussing; cancelling frees them for seating).
      for (const tableId of orderTableIds(order)) {
        await freeTableIfUnused(tableId, orderId)
      }

      await logAudit({
        user: session,
        action: 'order.cancelAfterClose',
        entity: 'order',
        entityId: orderId,
        details:
          `Cancelled CLOSED (paid) order #${orderId} (EGP ${round2(order.totalAmount).toFixed(2)}` +
          `${order.table ? `, table ${order.table.name}` : ''}) — developer PIN verified` +
          (capacity > MONEY_EPSILON
            ? ` — EGP ${capacity.toFixed(2)} reversed as a negative ${method} payment`
            : ' — nothing left to reverse'),
      })

      return NextResponse.json({
        order: serializeOrder(updated),
        cancel: {
          reversedAmount: capacity,
          method,
        },
      })
    }

    if (order.status === 'cancelled') {
      throw new ApiError('Order is already cancelled', 400)
    }
    // r65: 'revoked' checks are terminal (revoke route contract) — nothing
    // may cancel them (previously fell through and would flip the status).
    if (order.status === 'revoked') {
      throw new ApiError('Cannot cancel a revoked check — it is terminal', 400)
    }
    // r31 audit fix (F9): a merged order's items live on in the target
    // order — cancelling the emptied source would orphan the merge trail.
    if (order.status === 'merged') {
      throw new ApiError('Cannot cancel a merged order — it lives on in the merged target', 400)
    }
    if (!privileged && order.userId !== sessionUserId(session)) {
      throw new ApiError('Only an admin or the waiter who created this order can cancel it', 403)
    }

    // R30 hybrid sync: the cancel write + its outbox event commit together
    const updated = await db.$transaction(async (tx) => {
      const saved = await tx.order.update({
        where: { id: orderId },
        data: { status: 'cancelled', closedAt: new Date() },
        include: ORDER_INCLUDE,
      })
      const orderRow = await tx.order.findUnique({ where: { id: orderId } })
      if (orderRow) {
        await emitOutboxEvent(tx, {
          entity: 'Order',
          entityId: orderId,
          operation: 'update',
          row: orderRow,
        })
      }
      return saved
    })

    // Release EVERY seating table (primary + merged extras) — only when no
    // other open order uses them. Cancelled orders make NO inventory changes.
    for (const tableId of orderTableIds(order)) {
      await freeTableIfUnused(tableId, orderId)
    }

    await logAudit({
      user: session,
      action: 'order.cancel',
      entity: 'order',
      entityId: orderId,
      details: `Cancelled order #${orderId} (EGP ${round2(order.totalAmount).toFixed(2)}${
        order.table ? `, table ${order.table.name}` : ', takeaway'
      })`,
    })

    return NextResponse.json({ order: serializeOrder(updated) })
  } catch (err) {
    return errorResponse(err)
  }
}
