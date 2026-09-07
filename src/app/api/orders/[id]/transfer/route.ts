// /api/orders/[id]/transfer — move an open order to another table (waiter/admin)

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import {
  findOpenOrderOnTable,
  getOrderOr404,
  orderTableIds,
  parseId,
  serializeOrder,
} from '@/lib/orders'

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    await requireAuth(req, ['waiter', 'admin', 'pos'])
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

    const previousTableIds = orderTableIds(order)

    await db.$transaction(async (tx) => {
      // The whole seating (primary + merged extra tables) re-houses at the
      // single destination table: primary table moves, extras are released.
      await tx.order.update({
        where: { id: orderId },
        data: { tableId, extraTableIds: null },
      })
      for (const previousTableId of previousTableIds) {
        if (previousTableId === tableId) continue
        const stillOpen = await findOpenOrderOnTable(previousTableId, orderId)
        if (!stillOpen) {
          await tx.restaurantTable.update({
            where: { id: previousTableId },
            data: { status: 'free' },
          })
        }
      }
      await tx.restaurantTable.update({
        where: { id: tableId },
        data: { status: 'occupied' },
      })
    })

    const fresh = await getOrderOr404(orderId)
    return NextResponse.json({ order: serializeOrder(fresh) })
  } catch (err) {
    return errorResponse(err)
  }
}
