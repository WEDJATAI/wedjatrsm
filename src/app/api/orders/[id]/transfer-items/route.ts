// /api/orders/[id]/transfer-items — move specific items from this order to
// another OPEN order (waiter/admin). Inventory and table statuses are
// untouched (both orders keep their tables); payments stay on their orders.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { getOrderOr404, parseId, recomputeTotals, serializeOrder } from '@/lib/orders'

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    await requireAuth(req, ['waiter', 'admin', 'pos'])
    const { id } = await ctx.params
    const sourceId = parseId(id, 'order id')

    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })
    const targetOrderId = Number(body?.targetOrderId)
    if (body?.targetOrderId == null || !Number.isInteger(targetOrderId) || targetOrderId <= 0) {
      throw new ApiError('targetOrderId is required', 400)
    }
    if (targetOrderId === sourceId) {
      throw new ApiError('Cannot transfer items to the same order', 400)
    }

    const rawItemIds = body?.itemIds
    if (!Array.isArray(rawItemIds) || rawItemIds.length === 0) {
      throw new ApiError('itemIds is required', 400)
    }
    const itemIds = rawItemIds.map(Number)
    if (itemIds.some((itemId) => !Number.isInteger(itemId) || itemId <= 0)) {
      throw new ApiError('itemIds contains an invalid item id', 400)
    }

    const source = await db.order.findUnique({ where: { id: sourceId } })
    if (!source) throw new ApiError('Order not found', 404)
    if (source.status !== 'open') {
      throw new ApiError('Only open orders can be modified', 400)
    }

    const target = await db.order.findUnique({ where: { id: targetOrderId } })
    if (!target) throw new ApiError('Target order not found', 404)
    if (target.status !== 'open') {
      throw new ApiError('Only open orders can be modified', 400)
    }

    // Every requested item must exist AND belong to the source order
    const items = await db.orderItem.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, orderId: true },
    })
    const itemById = new Map(items.map((item) => [item.id, item]))
    for (const itemId of itemIds) {
      const item = itemById.get(itemId)
      if (!item || item.orderId !== sourceId) {
        throw new ApiError(`Item ${itemId} does not belong to this order`, 400)
      }
    }

    // Re-parent the items onto the target order (single atomic update)
    await db.$transaction(async (tx) => {
      await tx.orderItem.updateMany({
        where: { id: { in: itemIds } },
        data: { orderId: targetOrderId },
      })
    })

    // Recompute both orders' money fields from their current items.
    // A source left with zero items simply stays open (no auto-cancel).
    await recomputeTotals(sourceId)
    await recomputeTotals(targetOrderId)

    const sourceOrder = await getOrderOr404(sourceId)
    const targetOrder = await getOrderOr404(targetOrderId)
    return NextResponse.json({
      source: serializeOrder(sourceOrder),
      target: serializeOrder(targetOrder),
    })
  } catch (err) {
    return errorResponse(err)
  }
}
