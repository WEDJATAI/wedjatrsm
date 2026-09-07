import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'

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

function parseDisplayOrder(value: unknown): number {
  if (value === undefined || value === null) return 0
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) {
    throw new ApiError('Display order must be an integer ≥ 0', 400)
  }
  return n
}

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req)
    const all = new URL(req.url).searchParams.get('all') === '1'
    const categories = await db.category.findMany({
      where: all ? {} : { active: true },
      orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
      include: {
        _count: { select: { products: { where: { active: true } } } },
      },
    })
    return NextResponse.json({
      categories: categories.map((c) => ({
        id: c.id,
        name: c.name,
        nameAr: c.nameAr,
        displayOrder: c.displayOrder,
        active: c.active,
        productCount: c._count.products,
      })),
    })
  } catch (err) {
    return errorResponse(err)
  }
}

/** Optional Arabic name field → trimmed string | null (empty/null clears) | undefined (absent). */
function parseNameAr(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') throw new ApiError('Arabic name must be a string', 400)
  const s = value.trim()
  return s === '' ? null : s
}

export async function POST(req: NextRequest) {
  try {
    await requireAuth(req, ['admin', 'categories'])
    const body = await readBody(req)

    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) throw new ApiError('Name is required', 400)
    const displayOrder = parseDisplayOrder(body.displayOrder)
    const nameAr = parseNameAr(body.nameAr)

    const category = await db.category.create({
      data: { name, displayOrder, nameAr: nameAr ?? null },
    })
    return NextResponse.json({ category: { ...category, productCount: 0 } })
  } catch (err) {
    return errorResponse(err)
  }
}
