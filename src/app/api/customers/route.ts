// /api/customers — R13 customers & loyalty directory.
// GET  (any authenticated staff): search/list — POS phone lookup included.
// POST (admin/customers): create a customer profile.

import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { normalizePersonName } from '@/lib/names'

function serializeCustomer(c: {
  id: number
  name: string
  phone: string | null
  visits: number
  points: number
  totalSpent: number
  lastVisitAt: Date | null
  notes: string | null
  active: boolean
  createdAt: Date
}) {
  return {
    ...c,
    points: Math.round(c.points * 100) / 100,
    totalSpent: Math.round(c.totalSpent * 100) / 100,
    lastVisitAt: c.lastVisitAt ? c.lastVisitAt.toISOString() : null,
    createdAt: c.createdAt.toISOString(),
  }
}

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req)
    const { searchParams } = new URL(req.url)
    const q = (searchParams.get('q') ?? '').trim()
    const phone = (searchParams.get('phone') ?? '').trim()
    const limit = Math.min(50, Math.max(1, Number(searchParams.get('limit') ?? 30) || 30))
    const includeInactive = searchParams.get('all') === '1'

    const where: Prisma.CustomerWhereInput = {}
    if (!includeInactive) where.active = true
    if (phone) {
      where.phone = phone
    } else if (q) {
      // SQLite LIKE is case-insensitive for ASCII
      where.OR = [{ name: { contains: q } }, { phone: { contains: q } }]
    }

    const customers = await db.customer.findMany({
      where,
      // SQLite DESC sorts NULLs last → most-recent visitors first,
      // never-visited customers at the end.
      orderBy: [{ lastVisitAt: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    })
    return NextResponse.json({ customers: customers.map(serializeCustomer) })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireAuth(req, ['admin', 'customers', 'pos', 'waiter'])
    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })

    const name = normalizePersonName(String(body?.name ?? ''))
    if (name.length < 1 || name.length > 60) {
      throw new ApiError('Customer name is required (1-60 characters)', 400)
    }

    let phone: string | null = null
    if (body?.phone != null) {
      const raw = String(body.phone).trim()
      if (raw.length > 20) throw new ApiError('Phone is too long (max 20 characters)', 400)
      phone = raw || null
    }
    if (phone) {
      const clash = await db.customer.findUnique({ where: { phone } })
      if (clash) throw new ApiError('A customer with this phone already exists', 409)
    }

    let notes: string | null = null
    if (body?.notes != null) {
      const raw = String(body.notes).trim()
      if (raw.length > 300) throw new ApiError('Notes are too long (max 300 characters)', 400)
      notes = raw || null
    }

    // optional initial points (admin comp/goodwill — audited)
    let points = 0
    if (body?.points != null) {
      points = Number(body.points)
      if (!Number.isFinite(points) || points < 0 || points > 1_000_000) {
        throw new ApiError('Points must be between 0 and 1,000,000', 400)
      }
      if (user.role !== 'admin' && points > 0) {
        throw new ApiError('Only admins can grant initial points', 403)
      }
    }

    const created = await db.customer.create({
      data: { name, phone, notes, points },
    })

    await logAudit({
      user,
      action: 'customer.create',
      entity: 'customer',
      entityId: created.id,
      details: `${name}${phone ? ` (phone ${phone})` : ''}${
        points > 0 ? ` — initial points ${points}` : ''
      }`,
    })

    return NextResponse.json({ customer: serializeCustomer(created) })
  } catch (err) {
    return errorResponse(err)
  }
}
