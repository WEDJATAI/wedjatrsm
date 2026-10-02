// /api/promotions/[id] — update (PUT, partial) + delete (DELETE).
// Same field validation as POST /api/promotions (helpers duplicated on
// purpose — the codebase convention keeps route files self-contained, and
// route modules must not import each other's non-handler exports); PUT
// validates the MERGED row so e.g. switching scope to 'category' without a
// categoryId fails with a clear 400 instead of an unmatchable promotion.

import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { PROMO_SCOPES, PROMO_TYPES } from '@/lib/constants'
import { toPromotionDTO } from '@/lib/promotions'

const PROMO_INCLUDE = {
  category: { select: { id: true, name: true } },
  product: { select: { id: true, name: true } },
} as const

type Ctx = { params: Promise<{ id: string }> }

function parseIdParam(id: string): number {
  const n = Number(id)
  if (!Number.isInteger(n) || n <= 0) throw new ApiError('Invalid promotion id', 400)
  return n
}

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

/** "HH:MM" 24h → trimmed string | null (empty clears) | undefined (absent). */
function parseTimeField(value: unknown, label: string): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') throw new ApiError(`${label} must be a string`, 400)
  const s = value.trim()
  if (s === '') return null
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) {
    throw new ApiError(`${label} must be a 24h "HH:MM" time`, 400)
  }
  return s
}

/** "YYYY-MM-DD" (or full ISO) → local-midnight Date | null (empty clears) |
 *  undefined (absent). Local midnight gives the "inclusive local day"
 *  semantics the evaluation library compares against. */
function parseDateField(value: unknown, label: string): Date | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') throw new ApiError(`${label} must be a date string`, 400)
  const s = value.trim()
  if (s === '') return null
  let d: Date
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, day] = s.split('-').map(Number)
    d = new Date(y, m - 1, day)
  } else {
    const parsed = new Date(s)
    if (Number.isNaN(parsed.getTime())) {
      throw new ApiError(`${label} must be a valid date (YYYY-MM-DD)`, 400)
    }
    d = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate())
  }
  if (Number.isNaN(d.getTime())) throw new ApiError(`${label} must be a valid date`, 400)
  return d
}

/** daysOfWeek → unique sorted CSV of getDay() digits ("0,1,2,3,4,5,6"). */
function parseDaysOfWeek(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (value === null) return '0,1,2,3,4,5,6'
  if (typeof value === 'string' && value.trim() === '') return '0,1,2,3,4,5,6'
  if (!Array.isArray(value)) throw new ApiError('daysOfWeek must be an array of day numbers', 400)
  const days = value.map(Number)
  if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw new ApiError('daysOfWeek entries must be integers 0-6 (0 = Sunday)', 400)
  }
  return [...new Set(days)].sort((a, b) => a - b).join(',') || '0,1,2,3,4,5,6'
}

/** Optional Arabic name field → trimmed string | null (empty/null clears) | undefined (absent). */
function parseNameAr(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') throw new ApiError('Arabic name must be a string', 400)
  const s = value.trim()
  return s === '' ? null : s
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  try {
    const session = await requireAuth(req, ['admin', 'promotions'])
    const { id } = await ctx.params
    const promoId = parseIdParam(id)

    const existing = await db.promotion.findUnique({
      where: { id: promoId },
      include: PROMO_INCLUDE,
    })
    if (!existing) throw new ApiError('Promotion not found', 404)

    const body = await readBody(req)
    const data: Prisma.PromotionUpdateInput = {}

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) {
        throw new ApiError('Name cannot be empty', 400)
      }
      data.name = body.name.trim()
    }
    const nameAr = parseNameAr(body.nameAr)
    if (nameAr !== undefined) data.nameAr = nameAr

    let type = existing.type
    if (body.type !== undefined) {
      const t = String(body.type)
      if (!(PROMO_TYPES as readonly string[]).includes(t)) {
        throw new ApiError(`type must be one of: ${PROMO_TYPES.join(', ')}`, 400)
      }
      type = t
      data.type = t
    }
    let value = existing.value
    if (body.value !== undefined) {
      const v = Number(body.value)
      if (!Number.isFinite(v) || v <= 0) {
        throw new ApiError('Value must be greater than 0', 400)
      }
      value = v
      data.value = Math.round(v * 100) / 100
    }
    if (type === 'percent' && value > 100) {
      throw new ApiError('Percent cannot exceed 100', 400)
    }

    let scope = existing.scope
    if (body.scope !== undefined) {
      const s = String(body.scope)
      if (!(PROMO_SCOPES as readonly string[]).includes(s)) {
        throw new ApiError(`scope must be one of: ${PROMO_SCOPES.join(', ')}`, 400)
      }
      scope = s
      data.scope = s
    }

    // scope targets: switching to a scoped promotion REQUIRES the target id
    // (validated against the DB); switching to 'order' clears both targets.
    let categoryId = existing.categoryId
    let productId = existing.productId
    if (body.categoryId !== undefined) {
      if (body.categoryId == null) {
        categoryId = null
        data.category = { disconnect: true }
      } else {
        const n = Number(body.categoryId)
        if (!Number.isInteger(n) || n <= 0) {
          throw new ApiError('categoryId must be a valid id', 400)
        }
        const found = await db.category.findUnique({ where: { id: n }, select: { id: true } })
        if (!found) throw new ApiError('Category not found', 400)
        categoryId = n
        data.category = { connect: { id: n } }
      }
    }
    if (body.productId !== undefined) {
      if (body.productId == null) {
        productId = null
        data.product = { disconnect: true }
      } else {
        const n = Number(body.productId)
        if (!Number.isInteger(n) || n <= 0) {
          throw new ApiError('productId must be a valid id', 400)
        }
        const found = await db.product.findUnique({ where: { id: n }, select: { id: true } })
        if (!found) throw new ApiError('Product not found', 400)
        productId = n
        data.product = { connect: { id: n } }
      }
    }

    // merged-state consistency: the FINAL row must carry its scope target
    if (scope === 'category' && categoryId == null) {
      throw new ApiError('A category is required for category-scoped promotions', 400)
    }
    if (scope === 'product' && productId == null) {
      throw new ApiError('An item is required for product-scoped promotions', 400)
    }
    if (scope === 'order') {
      // whole-order promos never carry a target
      if (categoryId != null) {
        data.category = { disconnect: true }
      }
      if (productId != null) {
        data.product = { disconnect: true }
      }
    }

    const days = parseDaysOfWeek(body.daysOfWeek)
    if (days !== undefined) data.daysOfWeek = days
    const startTime = parseTimeField(body.startTime, 'startTime')
    if (startTime !== undefined) data.startTime = startTime
    const endTime = parseTimeField(body.endTime, 'endTime')
    if (endTime !== undefined) data.endTime = endTime
    const startDate = parseDateField(body.startDate, 'startDate')
    if (startDate !== undefined) data.startDate = startDate
    const endDate = parseDateField(body.endDate, 'endDate')
    if (endDate !== undefined) data.endDate = endDate

    // merged date range must stay coherent
    const finalStart = startDate !== undefined ? startDate : existing.startDate
    const finalEnd = endDate !== undefined ? endDate : existing.endDate
    if (finalStart && finalEnd && finalEnd < finalStart) {
      throw new ApiError('End date must be on or after the start date', 400)
    }

    if (body.active !== undefined) data.active = Boolean(body.active)

    const updated = await db.promotion.update({
      where: { id: promoId },
      data,
      include: PROMO_INCLUDE,
    })
    await logAudit({
      user: session,
      action: 'promotion.update',
      entity: 'promotion',
      entityId: updated.id,
      details: `"${updated.name}" updated — ${
        updated.type === 'percent' ? `${updated.value}% off` : `EGP ${updated.value.toFixed(2)} off`
      }, ${
        updated.scope === 'order'
          ? 'whole order'
          : updated.scope === 'category'
            ? `category "${updated.category?.name ?? updated.categoryId}"`
            : `item "${updated.product?.name ?? updated.productId}"`
      }${updated.active ? '' : ' (inactive)'}`,
    })
    return NextResponse.json({ promotion: toPromotionDTO(updated) })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  try {
    const session = await requireAuth(req, ['admin', 'promotions'])
    const { id } = await ctx.params
    const promoId = parseIdParam(id)

    const existing = await db.promotion.findUnique({
      where: { id: promoId },
      include: PROMO_INCLUDE,
    })
    if (!existing) throw new ApiError('Promotion not found', 404)

    await db.promotion.delete({ where: { id: promoId } })
    await logAudit({
      user: session,
      action: 'promotion.delete',
      entity: 'promotion',
      entityId: promoId,
      details: `"${existing.name}" deleted — ${
        existing.type === 'percent'
          ? `${existing.value}% off`
          : `EGP ${existing.value.toFixed(2)} off`
      } ${
        existing.scope === 'order'
          ? 'whole order'
          : existing.scope === 'category'
            ? `category "${existing.category?.name ?? existing.categoryId}"`
            : `item "${existing.product?.name ?? existing.productId}"`
      }`,
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return errorResponse(err)
  }
}
