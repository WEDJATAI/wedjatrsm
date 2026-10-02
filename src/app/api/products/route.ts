import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { ALLERGENS, DIETARY_TAGS } from '@/lib/constants'

const PRODUCT_INCLUDE = {
  category: { select: { id: true, name: true, nameAr: true } },
  // R8: option groups offered with the product (ACTIVE groups + ACTIVE
  // options only) ordered by the attach sortOrder (= group.sortOrder)
  modifierGroups: {
    where: { modifierGroup: { active: true } },
    orderBy: [{ sortOrder: 'asc' }, { modifierGroupId: 'asc' }],
    include: {
      modifierGroup: {
        include: {
          modifiers: {
            where: { active: true },
            orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
          },
        },
      },
    },
  },
} satisfies Prisma.ProductInclude

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

// ─── R8: allergen / dietary tags + option-group links ───────────────

/** JSON string column → string[] (null/invalid → []). */
function parseTagColumn(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed.filter((v): v is string => typeof v === 'string')
    }
  } catch {
    // invalid JSON → treated as empty
  }
  return []
}

/**
 * Optional tag list (allergens/dietary) → deduped validated string[].
 * undefined = absent (don't touch), [] = explicit clear.
 */
function parseTagList(
  value: unknown,
  allowed: readonly string[],
  label: string,
): string[] | undefined {
  if (value === undefined) return undefined
  if (value === null) return []
  if (!Array.isArray(value)) throw new ApiError(`${label} must be an array`, 400)
  const out: string[] = []
  for (const v of value) {
    if (typeof v !== 'string' || !allowed.includes(v)) {
      throw new ApiError(`${label} contains an invalid value: ${String(v)}`, 400)
    }
    if (!out.includes(v)) out.push(v)
  }
  return out
}

/** modifierGroupIds: undefined (absent) | deduped integer id list. */
function parseModifierGroupIds(value: unknown): number[] | undefined {
  if (value === undefined) return undefined
  if (value === null) return []
  if (!Array.isArray(value)) {
    throw new ApiError('modifierGroupIds must be an array', 400)
  }
  const ids: number[] = []
  for (const v of value) {
    const n = Number(v)
    if (!Number.isInteger(n) || n < 1) {
      throw new ApiError('Invalid modifier group id', 400)
    }
    if (!ids.includes(n)) ids.push(n)
  }
  return ids
}

/** Validate every id is an ACTIVE ModifierGroup → [{id, sortOrder}] | null (absent). */
async function resolveActiveGroups(
  ids: number[] | undefined,
): Promise<{ id: number; sortOrder: number }[] | null> {
  if (ids === undefined) return null
  if (ids.length === 0) return []
  const groups = await db.modifierGroup.findMany({
    where: { id: { in: ids }, active: true },
    select: { id: true, sortOrder: true },
  })
  if (groups.length !== ids.length) {
    throw new ApiError('One or more modifier groups are invalid or inactive', 400)
  }
  return groups
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

type ProductWithRelations = Prisma.ProductGetPayload<{ include: typeof PRODUCT_INCLUDE }>

/** Product row → API payload: parsed tag arrays + ModifierGroupDTO[] (never raw JSON). */
function serializeProduct(p: ProductWithRelations) {
  return {
    ...p,
    allergens: parseTagColumn(p.allergens),
    dietary: parseTagColumn(p.dietary),
    modifierGroups: p.modifierGroups.map((link) => ({
      id: link.modifierGroup.id,
      name: link.modifierGroup.name,
      nameAr: link.modifierGroup.nameAr,
      minSelect: link.modifierGroup.minSelect,
      maxSelect: link.modifierGroup.maxSelect,
      active: link.modifierGroup.active,
      sortOrder: link.modifierGroup.sortOrder,
      modifiers: link.modifierGroup.modifiers.map((m) => ({
        id: m.id,
        name: m.name,
        nameAr: m.nameAr,
        priceDelta: round2(m.priceDelta),
        active: m.active,
        sortOrder: m.sortOrder,
      })),
    })),
  }
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
    return NextResponse.json({ products: products.map((p) => serializeProduct(p)) })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAuth(req, ['admin', 'products'])
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
    const nameAr = parseStringField(body, 'nameAr', 'Arabic name')
    const categoryId = parseCategoryId(body)

    if (categoryId !== null && categoryId !== undefined) {
      const category = await db.category.findUnique({
        where: { id: categoryId },
        select: { id: true },
      })
      if (!category) throw new ApiError('Category not found', 400)
    }

    // R8: allergens / dietary / option-group links
    const allergens = parseTagList(body.allergens, ALLERGENS, 'Allergens') ?? []
    const dietary = parseTagList(body.dietary, DIETARY_TAGS, 'Dietary') ?? []
    const modifierGroups = await resolveActiveGroups(parseModifierGroupIds(body.modifierGroupIds))

    const data: Prisma.ProductUncheckedCreateInput = {
      name,
      nameAr: nameAr ?? null,
      price,
      cost,
      lowStockThreshold,
      stock,
      isStockable,
      isSellable,
      sku: sku ?? null,
      imageUrl: imageUrl ?? null,
      categoryId: categoryId ?? null,
      allergens: allergens.length > 0 ? JSON.stringify(allergens) : null,
      dietary: dietary.length > 0 ? JSON.stringify(dietary) : null,
    }

    // Initial stock on a stockable product is booked as a purchase.
    if (isStockable && stock > 0) {
      data.inventoryTransactions = {
        create: { quantityChange: stock, reason: 'purchase' },
      }
    }

    const created = await db.$transaction(async (tx) => {
      const row = await tx.product.create({ data })
      // R8: attach the option groups (validated above — active groups only)
      if (modifierGroups && modifierGroups.length > 0) {
        await tx.productModifierGroup.createMany({
          data: modifierGroups.map((g) => ({
            productId: row.id,
            modifierGroupId: g.id,
            sortOrder: g.sortOrder,
          })),
        })
      }
      return row
    })

    const product = await db.product.findUniqueOrThrow({
      where: { id: created.id },
      include: PRODUCT_INCLUDE,
    })
    return NextResponse.json({ product: serializeProduct(product) })
  } catch (err) {
    return errorResponse(err)
  }
}
