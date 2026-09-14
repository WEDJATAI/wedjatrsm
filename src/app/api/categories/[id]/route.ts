import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
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

function parseIdParam(id: string): number {
  const n = Number(id)
  if (!Number.isInteger(n)) throw new ApiError('Invalid category id', 400)
  return n
}

/** Optional Arabic name field → trimmed string | null (empty/null clears) | undefined (absent). */
function parseNameAr(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') throw new ApiError('Arabic name must be a string', 400)
  const s = value.trim()
  return s === '' ? null : s
}

/** R11: station routing — see categories/route.ts for semantics. */
function parsePrepDestination(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== 'string') throw new ApiError('prepDestination must be a string', 400)
  const s = value.trim().toLowerCase().replace(/\s+/g, '-')
  if (s === '') return null
  if (s.length > 30 || !/^[a-z0-9-_]+$/.test(s)) {
    throw new ApiError('prepDestination must be 1-30 chars (letters, numbers, dashes)', 400)
  }
  return s
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAuth(req, ['admin', 'categories'])
    const { id } = await params
    const categoryId = parseIdParam(id)

    const existing = await db.category.findUnique({
      where: { id: categoryId },
      select: { id: true },
    })
    if (!existing) throw new ApiError('Category not found', 404)

    const body = await readBody(req)
    const data: Prisma.CategoryUpdateInput = {}

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) {
        throw new ApiError('Name cannot be empty', 400)
      }
      data.name = body.name.trim()
    }

    const nameAr = parseNameAr(body.nameAr)
    if (nameAr !== undefined) data.nameAr = nameAr

    if (body.displayOrder !== undefined) {
      const n = Number(body.displayOrder)
      if (!Number.isInteger(n) || n < 0) {
        throw new ApiError('Display order must be an integer ≥ 0', 400)
      }
      data.displayOrder = n
    }

    if (body.active !== undefined) {
      if (typeof body.active !== 'boolean') {
        throw new ApiError('Active must be true or false', 400)
      }
      data.active = body.active
    }

    const prepDestination = parsePrepDestination(body.prepDestination)
    if (prepDestination !== undefined) data.prepDestination = prepDestination

    const updated = await db.category.update({
      where: { id: categoryId },
      data,
      include: {
        _count: { select: { products: { where: { active: true } } } },
      },
    })
    return NextResponse.json({
      category: {
        id: updated.id,
        name: updated.name,
        nameAr: updated.nameAr,
        displayOrder: updated.displayOrder,
        prepDestination: updated.prepDestination,
        active: updated.active,
        productCount: updated._count.products,
      },
    })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAuth(req, ['admin', 'categories'])
    const { id } = await params
    const categoryId = parseIdParam(id)

    const existing = await db.category.findUnique({
      where: { id: categoryId },
      select: { id: true },
    })
    if (!existing) throw new ApiError('Category not found', 404)

    // Soft delete — keep products/history intact.
    await db.category.update({
      where: { id: categoryId },
      data: { active: false },
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return errorResponse(err)
  }
}
