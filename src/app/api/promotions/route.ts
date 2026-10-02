// /api/promotions — R17 promotions engine (Foodics happy-hour style).
// GET: list (admin/'promotions' for management; also 'pos' so the POS cart
//      can preview the live best promotion — waiters hold the 'pos'
//      permission, and the promo preview must never require admin rights).
// POST: create (admin/'promotions' only — money rules are management work).

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { PROMO_SCOPES, PROMO_TYPES } from '@/lib/constants'
import { toPromotionDTO } from '@/lib/promotions'

const PROMO_INCLUDE = {
  category: { select: { id: true, name: true } },
  product: { select: { id: true, name: true } },
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

export async function GET(req: NextRequest) {
  try {
    // 'pos' is included deliberately: the POS cart runs a display-only live
    // preview of the best promotion (server-authoritative application lives
    // in lib/orders.ts recomputeTotals), so waiters must be able to read the
    // ACTIVE list. Full management (create/update/delete) stays below.
    await requireAuth(req, ['admin', 'promotions', 'pos'])
    const activeOnly = new URL(req.url).searchParams.get('activeOnly') === '1'
    const promotions = await db.promotion.findMany({
      where: activeOnly ? { active: true } : {},
      include: PROMO_INCLUDE,
      orderBy: { id: 'asc' },
    })
    return NextResponse.json({ promotions: promotions.map(toPromotionDTO) })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth(req, ['admin', 'promotions'])
    const body = await readBody(req)

    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) throw new ApiError('Name is required', 400)
    const nameArRaw = body.nameAr
    if (nameArRaw != null && typeof nameArRaw !== 'string') {
      throw new ApiError('Arabic name must be a string', 400)
    }
    const nameAr =
      nameArRaw == null || nameArRaw.trim() === '' ? null : (nameArRaw as string).trim()

    const type = body.type == null ? 'percent' : String(body.type)
    if (!(PROMO_TYPES as readonly string[]).includes(type)) {
      throw new ApiError(`type must be one of: ${PROMO_TYPES.join(', ')}`, 400)
    }
    const value = Number(body.value)
    if (!Number.isFinite(value) || value <= 0) {
      throw new ApiError('Value must be greater than 0', 400)
    }
    if (type === 'percent' && value > 100) {
      throw new ApiError('Percent cannot exceed 100', 400)
    }

    const scope = body.scope == null ? 'order' : String(body.scope)
    if (!(PROMO_SCOPES as readonly string[]).includes(scope)) {
      throw new ApiError(`scope must be one of: ${PROMO_SCOPES.join(', ')}`, 400)
    }

    // scope target — required for category/product scopes, verified to exist
    let categoryId: number | null = null
    let productId: number | null = null
    if (scope === 'category') {
      const n = Number(body.categoryId)
      if (!Number.isInteger(n) || n <= 0) {
        throw new ApiError('A category is required for category-scoped promotions', 400)
      }
      const found = await db.category.findUnique({ where: { id: n }, select: { id: true } })
      if (!found) throw new ApiError('Category not found', 400)
      categoryId = n
    } else if (scope === 'product') {
      const n = Number(body.productId)
      if (!Number.isInteger(n) || n <= 0) {
        throw new ApiError('An item is required for product-scoped promotions', 400)
      }
      const found = await db.product.findUnique({ where: { id: n }, select: { id: true } })
      if (!found) throw new ApiError('Product not found', 400)
      productId = n
    }

    const daysOfWeek = parseDaysOfWeek(body.daysOfWeek) ?? '0,1,2,3,4,5,6'
    const startTime = parseTimeField(body.startTime, 'startTime') ?? null
    const endTime = parseTimeField(body.endTime, 'endTime') ?? null
    const startDate = parseDateField(body.startDate, 'startDate') ?? null
    const endDate = parseDateField(body.endDate, 'endDate') ?? null
    if (startDate && endDate && endDate < startDate) {
      throw new ApiError('End date must be on or after the start date', 400)
    }
    const active = body.active == null ? true : Boolean(body.active)

    const created = await db.promotion.create({
      data: {
        name,
        nameAr,
        type,
        value: Math.round(value * 100) / 100,
        scope,
        categoryId,
        productId,
        daysOfWeek,
        startTime,
        endTime,
        startDate,
        endDate,
        active,
      },
      include: PROMO_INCLUDE,
    })
    await logAudit({
      user: session,
      action: 'promotion.create',
      entity: 'promotion',
      entityId: created.id,
      details: `"${created.name}" — ${
        created.type === 'percent' ? `${created.value}% off` : `EGP ${created.value.toFixed(2)} off`
      } ${
        created.scope === 'order'
          ? 'whole order'
          : created.scope === 'category'
            ? `category "${created.category?.name ?? created.categoryId}"`
            : `item "${created.product?.name ?? created.productId}"`
      }${created.active ? '' : ' (inactive)'}`,
    })
    return NextResponse.json({ promotion: toPromotionDTO(created) })
  } catch (err) {
    return errorResponse(err)
  }
}
