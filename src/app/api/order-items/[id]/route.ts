// /api/order-items/[id] — kitchen item status / waiter item tweaks

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { ITEM_STATUSES } from '@/lib/constants'
import { parseId, serializeOrderItem } from '@/lib/orders'

type Ctx = { params: Promise<{ id: string }> }

export async function PUT(req: NextRequest, ctx: Ctx) {
  try {
    await requireAuth(req, ['kitchen', 'waiter', 'admin'])
    const { id } = await ctx.params
    const itemId = parseId(id, 'order item id')

    const item = await db.orderItem.findUnique({
      where: { id: itemId },
      include: { product: { select: { id: true, name: true } } },
    })
    if (!item) throw new ApiError('Order item not found', 404)

    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })

    const data: { status?: string; notes?: string | null; quantity?: number } = {}
    if (body?.status != null) {
      const status = String(body.status)
      if (!(ITEM_STATUSES as readonly string[]).includes(status)) {
        throw new ApiError(`Invalid item status "${status}"`, 400)
      }
      data.status = status
    }
    if (body?.notes !== undefined) {
      data.notes = body.notes == null ? null : String(body.notes)
    }
    if (body?.quantity != null) {
      const quantity = Number(body.quantity)
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new ApiError('Item quantity must be greater than zero', 400)
      }
      data.quantity = quantity
    }

    const updated = await db.orderItem.update({
      where: { id: itemId },
      data,
      include: { product: { select: { id: true, name: true } } },
    })
    return NextResponse.json({ item: serializeOrderItem(updated) })
  } catch (err) {
    return errorResponse(err)
  }
}
