// /api/orders/[id]/transfer — move an open order to another table (waiter/admin)

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { emitOutboxEvent } from '@/lib/hybrid-sync/outbox'
import {
  findOpenOrderOnTable,
  getOrderOr404,
  parseId,
  rehouseOpenOrder,
  serializeOrder,
} from '@/lib/orders'

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const user = await requireAuth(req, ['waiter', 'admin', 'pos'])
    const { id } = await ctx.params
    const orderId = parseId(id, 'order id')

    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })
    const tableId = Number(body?.tableId)
    if (body?.tableId == null || !Number.isInteger(tableId)) {
      throw new ApiError('tableId is required', 400)
    }

    const order = await getOrderOr404(orderId)
    if (order.status !== 'open') {
      throw new ApiError('Only open orders can be transferred', 400)
    }

    // Target table must exist + be active, and host no OTHER open order
    // (as primary OR merged-seating extra table).
    const table = await db.restaurantTable.findUnique({ where: { id: tableId } })
    if (!table || !table.active) throw new ApiError('Table not found', 404)
    const otherOpenOrder = await findOpenOrderOnTable(tableId, orderId)
    if (otherOpenOrder) {
      throw new ApiError(`Table "${table.name}" already has an open order`, 400)
    }

    await db.$transaction(async (tx) => {
      // p11-a hardening (same class as the p8 payments race): the
      // destination check above ran OUTSIDE this tx — a concurrent transfer
      // could have claimed the table in between. Re-assert authoritatively
      // on `tx` (sees in-flight writes) before re-housing; a violation
      // aborts the whole transaction.
      const raced = await findOpenOrderOnTable(tableId, orderId, tx)
      if (raced) {
        throw new ApiError(`Table "${table.name}" already has an open order`, 400)
      }
      // The whole seating (primary + merged extra tables) re-houses at the
      // single destination table: primary table moves, extras are released.
      // R9: shared with the human-confirmed AI movement flow (lib/vision.ts).
      await rehouseOpenOrder(tx, order, tableId)
      // R30 hybrid sync: the moved order rides an outbox event in the SAME
      // transaction (final row read inside the tx)
      const orderRow = await tx.order.findUnique({ where: { id: orderId } })
      if (orderRow) {
        await emitOutboxEvent(tx, {
          entity: 'Order',
          entityId: orderId,
          operation: 'update',
          row: orderRow,
        })
      }
    })

    const fresh = await getOrderOr404(orderId)
    const serialized = serializeOrder(fresh)

    await logAudit({
      user,
      action: 'order.transfer',
      entity: 'order',
      entityId: orderId,
      details: `Order #${orderId} moved from ${
        order.table ? `table ${order.table.name}` : 'takeaway'
      } to table ${table.name}`,
    })

    return NextResponse.json({ order: serialized })
  } catch (err) {
    return errorResponse(err)
  }
}
