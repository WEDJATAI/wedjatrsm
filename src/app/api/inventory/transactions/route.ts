import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, errorResponse, ApiError } from '@/lib/auth'
import type { InventoryTransaction } from '@/lib/types'

const DEFAULT_LIMIT = 100
const MIN_LIMIT = 1
const MAX_LIMIT = 500

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['waiter', 'admin'])

    const rawLimit = new URL(req.url).searchParams.get('limit')
    let limit = DEFAULT_LIMIT
    if (rawLimit !== null && rawLimit !== '') {
      const parsed = Number(rawLimit)
      if (!Number.isInteger(parsed)) {
        throw new ApiError(`limit must be an integer between ${MIN_LIMIT} and ${MAX_LIMIT}`, 400)
      }
      limit = Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, parsed))
    }

    const transactions = await db.inventoryTransaction.findMany({
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { product: { select: { id: true, name: true } } },
    })

    const payload: InventoryTransaction[] = transactions.map((t) => ({
      id: t.id,
      productId: t.productId,
      product: t.product ? { id: t.product.id, name: t.product.name } : null,
      quantityChange: t.quantityChange,
      reason: t.reason,
      orderId: t.orderId,
      createdAt: t.createdAt.toISOString(),
    }))

    return NextResponse.json({ transactions: payload })
  } catch (err) {
    return errorResponse(err)
  }
}
