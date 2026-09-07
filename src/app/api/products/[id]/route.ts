import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'

const PRODUCT_INCLUDE = {
  category: { select: { id: true, name: true, nameAr: true } },
} as const

async function readBody(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await req.json()
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // fall through — invalid/empty JSON is treated as an empty body
  }
  return {}
}

function parseIdParam(id: string, label: string): number {
  const n = Number(id)
  if (!Number.isInteger(n)) throw new ApiError(`Invalid ${label} id`, 400)
  return n
}

/** Optional non-negative number field → number | undefined (absent/null = not provided). */
function parseNumberField(
  body: Record<string, unknown>,
  key: string,
  label: string,
): number | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) {
    throw new ApiError(`${label} must be a number ≥ 0`, 400)
  }
  return n
}

/** Optional boolean field → boolean | undefined (absent/null = not provided). */
function parseBoolField(
  body: Record<string, unknown>,
  key: string,
  label: string,
): boolean | undefined {
  const value = body[key]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') {
    throw new ApiError(`${label} must be true or false`, 400)
  }
  return value
}

/** Optional string field → trimmed string | null (empty/null clears) | undefined (absent). */
function parseStringField(
  body: Record<string, unknown>,
  key: string,
  label: string,
): string | null | undefined {
  const value = body[key]
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') {
    throw new ApiError(`${label} must be a string`, 400)
  }
  const s = value.trim()
  return s === '' ? null : s
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAuth(req, ['admin', 'products'])
    const { id } = await params
    const productId = parseIdParam(id, 'product')

    const existing = await db.product.findUnique({
      where: { id: productId },
      select: { id: true },
    })
    if (!existing) throw new ApiError('Product not found', 404)

    const body = await readBody(req)
    // NOTE: `stock` in the body is deliberately ignored — stock is only
    // managed through POST /api/inventory/adjust.

    const data: Prisma.ProductUncheckedUpdateInput = {}

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) {
        throw new ApiError('Name cannot be empty', 400)
      }
      data.name = body.name.trim()
    }

    const price = parseNumberField(body, 'price', 'Price')
    if (price !== undefined) data.price = price

    const cost = parseNumberField(body, 'cost', 'Cost')
    if (cost !== undefined) data.cost = cost

    const lowStockThreshold = parseNumberField(
      body,
      'lowStockThreshold',
      'Low stock threshold',
    )
    if (lowStockThreshold !== undefined) data.lowStockThreshold = lowStockThreshold

    const isStockable = parseBoolField(body, 'isStockable', 'Is stockable')
    if (isStockable !== undefined) data.isStockable = isStockable

    const isSellable = parseBoolField(body, 'isSellable', 'Is sellable')
    if (isSellable !== undefined) data.isSellable = isSellable

    const sku = parseStringField(body, 'sku', 'SKU')
    if (sku !== undefined) data.sku = sku

    const imageUrl = parseStringField(body, 'imageUrl', 'Image URL')
    const nameAr = parseStringField(body, 'nameAr', 'Arabic name')
    if (nameAr !== undefined) data.nameAr = nameAr
    if (imageUrl !== undefined) data.imageUrl = imageUrl

    if (body.categoryId !== undefined) {
      if (body.categoryId !== null) {
        const n = Number(body.categoryId)
        if (!Number.isInteger(n)) {
          throw new ApiError('Category must be a valid id', 400)
        }
        const category = await db.category.findUnique({
          where: { id: n },
          select: { id: true },
        })
        if (!category) throw new ApiError('Category not found', 400)
        data.categoryId = n
      } else {
        data.categoryId = null
      }
    }

    const product = await db.product.update({
      where: { id: productId },
      data,
      include: PRODUCT_INCLUDE,
    })
    return NextResponse.json({ product })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAuth(req, ['admin', 'products'])
    const { id } = await params
    const productId = parseIdParam(id, 'product')

    const existing = await db.product.findUnique({
      where: { id: productId },
      select: { id: true },
    })
    if (!existing) throw new ApiError('Product not found', 404)

    // Soft delete — keep order history intact.
    await db.product.update({
      where: { id: productId },
      data: { active: false },
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return errorResponse(err)
  }
}
