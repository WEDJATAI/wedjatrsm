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

    // R8: allergens / dietary — validated, stored as JSON (null when empty)
    const allergens = parseTagList(body.allergens, ALLERGENS, 'Allergens')
    if (allergens !== undefined) {
      data.allergens = allergens.length > 0 ? JSON.stringify(allergens) : null
    }
    const dietary = parseTagList(body.dietary, DIETARY_TAGS, 'Dietary')
    if (dietary !== undefined) {
      data.dietary = dietary.length > 0 ? JSON.stringify(dietary) : null
    }

    // R8: option-group links — full replace, transactional
    const modifierGroups = await resolveActiveGroups(
      parseModifierGroupIds(body.modifierGroupIds),
    )

    await db.$transaction(async (tx) => {
      await tx.product.update({ where: { id: productId }, data })
      if (modifierGroups !== null) {
        await tx.productModifierGroup.deleteMany({ where: { productId } })
        if (modifierGroups.length > 0) {
          await tx.productModifierGroup.createMany({
            data: modifierGroups.map((g) => ({
              productId,
              modifierGroupId: g.id,
              sortOrder: g.sortOrder,
            })),
          })
        }
      }
    })

    const product = await db.product.findUniqueOrThrow({
      where: { id: productId },
      include: PRODUCT_INCLUDE,
    })
    return NextResponse.json({ product: serializeProduct(product) })
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
