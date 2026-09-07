// /api/orders/[id]/transfer — move an open order to another table (waiter/admin)

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { getOrderOr404, parseId, serializeOrder } from '@/lib/orders'

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
    // (tables currently 'free' or 'reserved' are both acceptable targets).
    const table = await db.restaurantTable.findUnique({ where: { id: tableId } })
    if (!table || !table.active) throw new ApiError('Table not found', 404)
    const otherOpenOrder = await db.order.findFirst({
      where: { tableId, status: 'open', id: { not: orderId } },
      select: { id: true },
    })
    if (otherOpenOrder) {
      throw new ApiError(`Table "${table.name}" already has an open order`, 400)
    }

    const previousTableId = order.tableId

    await db.$transaction(async (tx) => {
      await tx.order.update({ where: { id: orderId }, data: { tableId } })
      // Free the old table only when no other open order still references it
      if (previousTableId != null && previousTableId !== tableId) {
        const stillOpen = await tx.order.findFirst({
          where: { tableId: previousTableId, status: 'open', id: { not: orderId } },
          select: { id: true },
        })
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
