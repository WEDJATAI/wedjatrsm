import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'

const PRODUCT_INCLUDE = {
  category: { select: { id: true, name: true } },
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

/** categoryId: undefined (absent) | null (clear category) | integer id. */
function parseCategoryId(body: Record<string, unknown>): number | null | undefined {
  const value = body.categoryId
  if (value === undefined) return undefined
  if (value === null) return null
  const n = Number(value)
  if (!Number.isInteger(n)) {
    throw new ApiError('Category must be a valid id', 400)
  }
  return n
}

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req)
    const sp = new URL(req.url).searchParams
    const all = sp.get('all') === '1'
    const sellable = sp.get('sellable') === '1'
    const stockable = sp.get('stockable') === '1'
    const search = (sp.get('search') ?? '').trim()
    const categoryParam = sp.get('category')

    const where: Prisma.ProductWhereInput = {}
    if (!all) where.active = true
    if (sellable) where.isSellable = true
    if (stockable) where.isStockable = true
    if (categoryParam !== null && categoryParam !== '') {
      const categoryId = Number(categoryParam)
      if (Number.isInteger(categoryId)) where.categoryId = categoryId
    }
    if (search) {
      // SQLite LIKE is case-insensitive for ASCII
      where.OR = [
        { name: { contains: search } },
        { sku: { contains: search } },
      ]
    }

    const products = await db.product.findMany({
      where,
      orderBy: [{ category: { displayOrder: 'asc' } }, { name: 'asc' }],
      include: PRODUCT_INCLUDE,
    })
    return NextResponse.json({ products })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAuth(req, ['admin'])
    const body = await readBody(req)

    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) throw new ApiError('Name is required', 400)

    const price = parseNumberField(body, 'price', 'Price') ?? 0
    const cost = parseNumberField(body, 'cost', 'Cost') ?? 0
    const lowStockThreshold =
      parseNumberField(body, 'lowStockThreshold', 'Low stock threshold') ?? 0
    const stock = parseNumberField(body, 'stock', 'Stock') ?? 0
    const isStockable = parseBoolField(body, 'isStockable', 'Is stockable') ?? false
    const isSellable = parseBoolField(body, 'isSellable', 'Is sellable') ?? true
    const sku = parseStringField(body, 'sku', 'SKU')
    const imageUrl = parseStringField(body, 'imageUrl', 'Image URL')
    const categoryId = parseCategoryId(body)

    if (categoryId !== null && categoryId !== undefined) {
      const category = await db.category.findUnique({
        where: { id: categoryId },
        select: { id: true },
      })
      if (!category) throw new ApiError('Category not found', 400)
    }

    const data: Prisma.ProductUncheckedCreateInput = {
      name,
      price,
      cost,
      lowStockThreshold,
      stock,
      isStockable,
      isSellable,
      sku: sku ?? null,
      imageUrl: imageUrl ?? null,
      categoryId: categoryId ?? null,
    }

    // Initial stock on a stockable product is booked as a purchase.
    if (isStockable && stock > 0) {
      data.inventoryTransactions = {
        create: { quantityChange: stock, reason: 'purchase' },
      }
    }

    const product = await db.product.create({
      data,
      include: PRODUCT_INCLUDE,
    })
    return NextResponse.json({ product })
  } catch (err) {
    return errorResponse(err)
  }
}
