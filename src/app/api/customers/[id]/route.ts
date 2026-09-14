// /api/customers/[id] — R13 customer profile detail + edits.
// GET (any authenticated staff): profile + last 10 orders + upcoming reservations.
// PUT (admin/customers): edit name/phone/notes/active, adjust points (reason required).

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { normalizePersonName } from '@/lib/names'
import { ORDER_INCLUDE, parseId, serializeOrder } from '@/lib/orders'
import { RESERVATION_INCLUDE, serializeReservation } from '@/lib/reservations'

type Ctx = { params: Promise<{ id: string }> }

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    await requireAuth(req)
    const { id } = await ctx.params
    const customerId = parseId(id, 'customer id')

    const customer = await db.customer.findUnique({
      where: { id: customerId },
      include: {
        orders: {
          orderBy: { createdAt: 'desc' },
          take: 10,
          include: ORDER_INCLUDE,
        },
        reservations: {
          where: { status: 'pending' },
          orderBy: { reservedAt: 'asc' },
          take: 5,
          include: RESERVATION_INCLUDE,
        },
      },
    })
    if (!customer) throw new ApiError('Customer not found', 404)

    const { orders, reservations, ...base } = customer
    return NextResponse.json({
      customer: {
        ...base,
        points: round2(base.points),
        totalSpent: round2(base.totalSpent),
        lastVisitAt: base.lastVisitAt ? base.lastVisitAt.toISOString() : null,
        createdAt: base.createdAt.toISOString(),
        orders: orders.map(serializeOrder),
        reservations: reservations.map(serializeReservation),
      },
    })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  try {
    const user = await requireAuth(req, ['admin', 'customers'])
    const { id } = await ctx.params
    const customerId = parseId(id, 'customer id')

    const existing = await db.customer.findUnique({ where: { id: customerId } })
    if (!existing) throw new ApiError('Customer not found', 404)

    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })

    const data: {
      name?: string
      phone?: string | null
      notes?: string | null
      active?: boolean
      points?: { decrement: number } | { increment: number }
    } = {}
    const changed: string[] = []

    if (body?.name !== undefined) {
      const name = normalizePersonName(String(body.name))
      if (name.length < 1 || name.length > 60) {
        throw new ApiError('Customer name is required (1-60 characters)', 400)
      }
      data.name = name
      changed.push('name')
    }

    if (body?.phone !== undefined) {
      if (body.phone === null) {
        data.phone = null
        changed.push('phone')
      } else {
        const raw = String(body.phone).trim()
        if (raw.length > 20) throw new ApiError('Phone is too long (max 20 characters)', 400)
        if (raw && raw !== existing.phone) {
          const clash = await db.customer.findUnique({ where: { phone: raw } })
          if (clash && clash.id !== customerId) {
            throw new ApiError('Another customer already uses this phone', 409)
          }
        }
        data.phone = raw || null
        changed.push('phone')
      }
    }

    if (body?.notes !== undefined) {
      const raw = body.notes == null ? '' : String(body.notes).trim()
      if (raw.length > 300) throw new ApiError('Notes are too long (max 300 characters)', 400)
      data.notes = raw || null
      changed.push('notes')
    }

    if (body?.active !== undefined) {
      if (typeof body.active !== 'boolean') {
        throw new ApiError('active must be true or false', 400)
      }
      data.active = body.active
      changed.push(body.active ? 'active' : 'deactivated')
    }

    // Manual points adjustment (comp / correction / goodwill): a reason is
    // REQUIRED — the adjustment lands in the audit log with it.
    if (body?.pointsAdjust !== undefined) {
      const adj = Number(body.pointsAdjust?.delta)
      if (!Number.isFinite(adj) || adj === 0 || Math.abs(adj) > 1_000_000) {
        throw new ApiError('pointsAdjust.delta must be a non-zero number', 400)
      }
      const reason = String(body.pointsAdjust?.reason ?? '').trim()
      if (reason.length < 3 || reason.length > 200) {
        throw new ApiError('A points adjustment reason (3-200 characters) is required', 400)
      }
      const next = round2(existing.points + adj)
      if (next < 0) {
        throw new ApiError(
          `Adjustment would take the balance below zero (current ${round2(existing.points)})`,
          400,
        )
      }
      if (adj > 0) data.points = { increment: adj }
      else data.points = { decrement: -adj }
      changed.push(`points ${adj > 0 ? '+' : ''}${adj}`)

      await logAudit({
        user,
        action: 'customer.pointsAdjust',
        entity: 'customer',
        entityId: customerId,
        details: `${existing.name}: points ${round2(existing.points)} → ${next} (${adj > 0 ? '+' : ''}${adj}) — ${reason}`,
      })
    }

    if (changed.length === 0) throw new ApiError('Nothing to update', 400)

    const updated = await db.customer.update({ where: { id: customerId }, data })

    if (changed.some((c) => c !== 'points' && !c.startsWith('points '))) {
      await logAudit({
        user,
        action: 'customer.update',
        entity: 'customer',
        entityId: customerId,
        details: `${existing.name} — updated: ${changed.join(', ')}`,
      })
    }

    return NextResponse.json({
      customer: {
        ...updated,
        points: round2(updated.points),
        totalSpent: round2(updated.totalSpent),
        lastVisitAt: updated.lastVisitAt ? updated.lastVisitAt.toISOString() : null,
        createdAt: updated.createdAt.toISOString(),
      },
    })
  } catch (err) {
    return errorResponse(err)
  }
}
