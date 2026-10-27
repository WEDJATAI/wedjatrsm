// /api/orders/[id]/merge — merge a source order INTO this order (waiter/admin)

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { emitOutboxEvent } from '@/lib/hybrid-sync/outbox'
import {
  closeOrderIfFullyPaid,
  findOpenOrderOnTable,
  getOrderOr404,
  orderTableIds,
  parseId,
  recomputeTotals,
  serializeOrder,
} from '@/lib/orders'

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const user = await requireAuth(req, ['waiter', 'admin', 'pos'])
    const { id } = await ctx.params
    const targetId = parseId(id, 'order id')

    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })
    const sourceOrderId = Number(body?.sourceOrderId)
    if (body?.sourceOrderId == null || !Number.isInteger(sourceOrderId)) {
      throw new ApiError('sourceOrderId is required', 400)
    }
    if (sourceOrderId === targetId) {
      throw new ApiError('Cannot merge an order into itself', 400)
    }

    const target = await getOrderOr404(targetId)
    if (target.status !== 'open') {
      throw new ApiError('Only open orders can be merged', 400)
    }
    const source = await db.order.findUnique({ where: { id: sourceOrderId } })
    if (!source) throw new ApiError('Source order not found', 404)
    if (source.status !== 'open') {
      throw new ApiError('Only open orders can be merged', 400)
    }

    await db.$transaction(async (tx) => {
      // 0) A takeaway target adopts the source's table
      const targetTableId = target.tableId ?? source.tableId
      if (targetTableId !== target.tableId) {
        await tx.order.update({ where: { id: target.id }, data: { tableId: targetTableId } })
      }

      // 0b) Source order is consumed FIRST: 'merged' + closed, detached from
      //     its tables (primary + merged-seating extras are all released below)
      await tx.order.update({
        where: { id: source.id },
        data: { status: 'merged', closedAt: new Date(), tableId: null, extraTableIds: null },
      })

      // R30/R39 hybrid sync: BOTH affected orders ride outbox events BEFORE
      // the re-parent events below — the apply side guards Payment re-parents
      // with "the abandoned parent order must already be 'merged'", so the
      // order events MUST precede them in the outbox stream (same-tx final
      // rows: source already 'merged' here).
      for (const affectedId of [target.id, source.id]) {
        const orderRow = await tx.order.findUnique({ where: { id: affectedId } })
        if (orderRow) {
          await emitOutboxEvent(tx, {
            entity: 'Order',
            entityId: affectedId,
            operation: 'update',
            row: orderRow,
          })
        }
      }

      // 1) Re-parent every source item + payment onto the target order.
      //    R39 hybrid sync: each re-parented row rides its own outbox event
      //    (final state read inside the tx) — the old bulk updateMany left
      //    every other terminal showing the items/payments on the consumed
      //    source order (phase-2 gap from the r39 audit, now closed).
      const sourceItems = await tx.orderItem.findMany({ where: { orderId: source.id } })
      for (const item of sourceItems) {
        await tx.orderItem.update({ where: { id: item.id }, data: { orderId: target.id } })
        const itemRow = await tx.orderItem.findUnique({ where: { id: item.id } })
        if (itemRow) {
          await emitOutboxEvent(tx, {
            entity: 'OrderItem',
            entityId: item.id,
            operation: 'update',
            row: itemRow,
          })
        }
      }
      const sourcePayments = await tx.payment.findMany({ where: { orderId: source.id } })
      for (const payment of sourcePayments) {
        await tx.payment.update({ where: { id: payment.id }, data: { orderId: target.id } })
        const paymentRow = await tx.payment.findUnique({ where: { id: payment.id } })
        if (paymentRow) {
          await emitOutboxEvent(tx, {
            entity: 'Payment',
            entityId: payment.id,
            operation: 'update',
            row: paymentRow,
          })
        }
      }

      // 4) Table statuses: free EVERY source seating table (primary +
      //    extras) when no open order remains on it; keep the target's
      //    table occupied.
      //    p11-a fix: read via `tx` AND exclude the source order. The old
      //    global-pool read inside this transaction saw the PRE-tx snapshot
      //    (source still open on its table) and skipped the release — the
      //    source table stayed ghost-'occupied' with no order, blocking
      //    seating/transfer/merge on it until manual DB surgery.
      for (const sourceTableId of orderTableIds(source)) {
        const openOnSourceTable = await findOpenOrderOnTable(sourceTableId, source.id, tx)
        const flipStatus = openOnSourceTable ? 'occupied' : 'free'
        // R39: each table flip rides an outbox event in the same tx
        const flipped = await tx.restaurantTable.update({
          where: { id: sourceTableId },
          data: { status: flipStatus },
        })
        await emitOutboxEvent(tx, {
          entity: 'RestaurantTable',
          entityId: flipped.id,
          operation: 'update',
          row: flipped,
        })
      }
      if (targetTableId != null && !orderTableIds(source).includes(targetTableId)) {
        const occupied = await tx.restaurantTable.update({
          where: { id: targetTableId },
          data: { status: 'occupied' },
        })
        await emitOutboxEvent(tx, {
          entity: 'RestaurantTable',
          entityId: occupied.id,
          operation: 'update',
          row: occupied,
        })
      }

    })

    // Recompute the target's totals from its (now merged) items — keeps the
    // TARGET's discount, clamped to the new subtotal (recomputeTotals
    // semantics). Merging itself does NOT touch inventory.
    await recomputeTotals(targetId)

    // The moved payments may now fully cover the target: auto-close it
    // (status 'paid' + closedAt + idempotent inventory deduction + table
    // release) once the transaction above has committed.
    await closeOrderIfFullyPaid(targetId)

    const fresh = await getOrderOr404(targetId)
    const serialized = serializeOrder(fresh)

    await logAudit({
      user,
      action: 'order.merge',
      entity: 'order',
      entityId: targetId,
      details: `Merged order #${source.id} into order #${targetId} — new total EGP ${serialized.totalAmount.toFixed(
        2,
      )}`,
    })

    return NextResponse.json({ order: serialized })
  } catch (err) {
    return errorResponse(err)
  }
}
