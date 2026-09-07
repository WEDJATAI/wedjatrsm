// /api/orders/[id] — fetch (any authenticated) + modify open orders (waiter/admin)

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { COURSES } from '@/lib/constants'
import {
  checkStockAvailability,
  getOrderOr404,
  parseId,
  recomputeTotals,
  serializeOrder,
  validateOrderItems,
} from '@/lib/orders'

type Ctx = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    await requireAuth(req)
    const { id } = await ctx.params
    const orderId = parseId(id, 'order id')
    const order = await getOrderOr404(orderId)
    return NextResponse.json({ order: serializeOrder(order) })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  try {
    await requireAuth(req, ['waiter', 'admin', 'pos'])
    const { id } = await ctx.params
    const orderId = parseId(id, 'order id')

    const existing = await db.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true },
    })
    if (!existing) throw new ApiError('Order not found', 404)
    if (existing.status !== 'open') {
      throw new ApiError('Only open orders can be modified', 400)
    }

    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })
    const { addItems, removeItemIds, updateItems, discountAmount, guests } = body ?? {}

    // Add new items (same validation as order creation, stock-aware)
    if (addItems != null) {
      const items = await validateOrderItems(addItems)
      await checkStockAvailability(items, orderId)
      await db.orderItem.createMany({
        data: items.map((item) => ({
          orderId,
          productId: item.productId,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          notes: item.notes,
          course: item.course,
          status: 'new',
        })),
      })
    }

    // Remove items (must belong to this order)
    if (removeItemIds != null) {
      if (!Array.isArray(removeItemIds)) {
        throw new ApiError('removeItemIds must be an array of item ids', 400)
      }
      const ids = removeItemIds.map(Number)
      if (ids.some((itemId) => !Number.isInteger(itemId) || itemId <= 0)) {
        throw new ApiError('removeItemIds contains an invalid item id', 400)
      }
      if (ids.length > 0) {
        await db.orderItem.deleteMany({ where: { id: { in: ids }, orderId } })
      }
    }

    // Update item quantity / notes / course (must belong to this order)
    if (updateItems != null) {
      if (!Array.isArray(updateItems)) {
        throw new ApiError('updateItems must be an array', 400)
      }
      for (const raw of updateItems) {
        const itemId = Number(raw?.id)
        if (!Number.isInteger(itemId) || itemId <= 0) {
          throw new ApiError('updateItems contains an invalid item id', 400)
        }
        const data: { quantity?: number; notes?: string | null; course?: string } = {}
        if (raw.quantity != null) {
          const quantity = Number(raw.quantity)
          if (!Number.isFinite(quantity) || quantity <= 0) {
            throw new ApiError('Item quantity must be greater than zero', 400)
          }
          data.quantity = quantity
        }
        if (raw.notes !== undefined) {
          data.notes = raw.notes == null ? null : String(raw.notes)
        }
        if (raw.course != null) {
          const course = String(raw.course)
          if (!(COURSES as readonly string[]).includes(course)) {
            throw new ApiError(`Invalid course "${course}"`, 400)
          }
          data.course = course
        }
        const result = await db.orderItem.updateMany({ where: { id: itemId, orderId }, data })
        if (result.count === 0) {
          throw new ApiError(`Order item ${itemId} not found`, 404)
        }
      }
    }

    // Absolute discount in EGP (clamped to subtotal inside recomputeTotals)
    if (discountAmount != null) {
      const discount = Number(discountAmount)
      if (!Number.isFinite(discount) || discount < 0) {
        throw new ApiError('Discount amount must be a non-negative number', 400)
      }
      await db.order.update({ where: { id: orderId }, data: { discountAmount: discount } })
    }

    // Number of guests seated on this order (integer 1-30)
    if (guests != null) {
      const parsedGuests = Number(guests)
      if (!Number.isInteger(parsedGuests) || parsedGuests < 1 || parsedGuests > 30) {
        throw new ApiError('Guests must be between 1 and 30', 400)
      }
      await db.order.update({ where: { id: orderId }, data: { guests: parsedGuests } })
    }

    const order = await recomputeTotals(orderId)
    return NextResponse.json({ order })
  } catch (err) {
    return errorResponse(err)
  }
}
