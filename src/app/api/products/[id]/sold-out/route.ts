// /api/products/[id]/sold-out — R13 "86" quick toggle (PATCH).
// One-tap availability flip from the POS product tile OR the admin menu.
// Open to waiters (operational, reversible, audited) — same philosophy as
// Foodics' 86 list: the floor staff knows first when something runs out.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { parseId } from '@/lib/orders'

type Ctx = { params: Promise<{ id: string }> }

export async function PATCH(req: NextRequest, ctx: Ctx) {
  try {
    const user = await requireAuth(req, ['admin', 'products', 'waiter', 'kitchen', 'pos'])
    const { id } = await ctx.params
    const productId = parseId(id, 'product id')

    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })
    const soldOut = body?.soldOut
    if (typeof soldOut !== 'boolean') {
      throw new ApiError('soldOut must be true or false', 400)
    }

    const existing = await db.product.findUnique({
      where: { id: productId },
      select: { id: true, name: true, soldOut: true, active: true },
    })
    if (!existing || !existing.active) throw new ApiError('Product not found', 404)

    await db.product.update({
      where: { id: productId },
      data: { soldOut },
    })

    await logAudit({
      user,
      action: 'product.soldOut',
      entity: 'product',
      entityId: productId,
      details: `${existing.name} ${soldOut ? 'marked SOLD OUT (86)' : 'back in stock'}${
        existing.soldOut === soldOut ? ' (no change)' : ''
      }`,
    })

    return NextResponse.json({ product: { id: productId, soldOut } })
  } catch (err) {
    return errorResponse(err)
  }
}
