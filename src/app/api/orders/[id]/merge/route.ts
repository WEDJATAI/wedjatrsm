// /api/orders/[id]/merge — merge a source order INTO this order (waiter/admin)

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
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
      // 1) Re-parent every source item + payment onto the target order
      await tx.orderItem.updateMany({
        where: { orderId: source.id },
        data: { orderId: target.id },
      })
      await tx.payment.updateMany({
        where: { orderId: source.id },
        data: { orderId: target.id },
      })

      // 2) A takeaway target adopts the source's table
      const targetTableId = target.tableId ?? source.tableId
      if (targetTableId !== target.tableId) {
        await tx.order.update({ where: { id: target.id }, data: { tableId: targetTableId } })
      }

      // 3) Source order is consumed: 'merged' + closed, detached from its
      //    tables (primary + merged-seating extras are all released below)
      await tx.order.update({
        where: { id: source.id },
        data: { status: 'merged', closedAt: new Date(), tableId: null, extraTableIds: null },
      })

      // 4) Table statuses: free EVERY source seating table (primary +
      //    extras) when no open order remains on it; keep the target's
      //    table occupied.
      for (const sourceTableId of orderTableIds(source)) {
        const openOnSourceTable = await findOpenOrderOnTable(sourceTableId)
        if (!openOnSourceTable) {
          await tx.restaurantTable.update({
            where: { id: sourceTableId },
            data: { status: 'free' },
          })
        } else {
          await tx.restaurantTable.update({
            where: { id: sourceTableId },
            data: { status: 'occupied' },
          })
        }
      }
      if (targetTableId != null && !orderTableIds(source).includes(targetTableId)) {
        await tx.restaurantTable.update({
          where: { id: targetTableId },
          data: { status: 'occupied' },
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
