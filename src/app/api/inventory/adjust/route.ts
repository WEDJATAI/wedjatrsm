import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, errorResponse, ApiError } from '@/lib/auth'
import type { Product } from '@/lib/types'

const round2 = (n: number): number => Math.round(n * 100) / 100

const ADJUST_REASONS = ['purchase', 'adjustment', 'waste']

type DbProduct = {
  id: number
  name: string
  categoryId: number | null
  category?: { id: number; name: string } | null
  price: number
  cost: number
  isStockable: boolean
  isSellable: boolean
  sku: string | null
  imageUrl: string | null
  active: boolean
  lowStockThreshold: number
  stock: number
  createdAt: Date
}

/** Serialize a product row (with optional category) for the API. */
function serializeProduct(p: DbProduct): Product & { createdAt: string } {
  return {
    id: p.id,
    name: p.name,
    categoryId: p.categoryId,
    category: p.category ? { id: p.category.id, name: p.category.name } : null,
    price: p.price,
    cost: p.cost,
    isStockable: p.isStockable,
    isSellable: p.isSellable,
    sku: p.sku,
    imageUrl: p.imageUrl,
    active: p.active,
    lowStockThreshold: p.lowStockThreshold,
    stock: p.stock,
    createdAt: p.createdAt.toISOString(),
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAuth(req, ['admin', 'inventory'])

    let body: unknown
    try {
      body = await req.json()
    } catch {
      throw new ApiError('Invalid JSON body', 400)
    }
    const data = (body ?? {}) as Record<string, unknown>

    const productId = Number(data.productId)
    if (!Number.isInteger(productId)) {
      throw new ApiError('productId must be an integer', 400)
    }

    const quantityChange = Number(data.quantityChange)
    if (!Number.isFinite(quantityChange) || quantityChange === 0) {
      throw new ApiError('quantityChange must be a non-zero number', 400)
    }

    const reason = typeof data.reason === 'string' ? data.reason.trim() : ''
    if (!ADJUST_REASONS.includes(reason)) {
      throw new ApiError("reason must be one of 'purchase', 'adjustment', 'waste'", 400)
    }

    const note =
      typeof data.note === 'string' && data.note.trim() !== '' ? data.note.trim() : undefined

    const product = await db.product.findUnique({ where: { id: productId } })
    if (!product) {
      throw new ApiError('Product not found', 400)
    }
    if (!product.active || !product.isStockable) {
      throw new ApiError('Product is not an active stockable item', 400)
    }

    const newStock = product.stock + quantityChange
    if (newStock < 0) {
      throw new ApiError(
        `Insufficient stock: cannot reduce below zero (current ${product.stock})`,
        400,
      )
    }

    const updated = await db.$transaction(async (tx) => {
      const saved = await tx.product.update({
        where: { id: productId },
        data: { stock: newStock },
        include: { category: { select: { id: true, name: true } } },
      })
      await tx.inventoryTransaction.create({
        data: {
          productId,
          quantityChange,
          reason: note ? `${reason} (${note})` : reason,
        },
      })
      return saved
    })

    return NextResponse.json({ product: serializeProduct(updated) })
  } catch (err) {
    return errorResponse(err)
  }
}
