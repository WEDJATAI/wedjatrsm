// /api/reservations — booking board (R11)
// GET  (any authenticated): list reservations (optional status / from / to).
// POST (waiter/admin/pos/reservations): create a pending booking.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { RESERVATION_STATUSES } from '@/lib/constants'
import {
  RESERVATION_INCLUDE,
  serializeReservation,
  type ReservationWithRelations,
} from '@/lib/reservations'

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req)
    const { searchParams } = new URL(req.url)
    const status = searchParams.get('status')
    const from = searchParams.get('from')
    const to = searchParams.get('to')

    const where: Record<string, unknown> = {}
    if (status) {
      if (!(RESERVATION_STATUSES as readonly string[]).includes(status)) {
        throw new ApiError(`Invalid status filter "${status}"`, 400)
      }
      where.status = status
    }
    if (from || to) {
      const reservedAt: Record<string, Date> = {}
      if (from) {
        const d = new Date(from)
        if (Number.isNaN(d.getTime())) throw new ApiError('Invalid "from" datetime', 400)
        reservedAt.gte = d
      }
      if (to) {
        const d = new Date(to)
        if (Number.isNaN(d.getTime())) throw new ApiError('Invalid "to" datetime', 400)
        reservedAt.lte = d
      }
      where.reservedAt = reservedAt
    }

    const reservations: ReservationWithRelations[] = await db.reservation.findMany({
      where,
      orderBy: { reservedAt: 'asc' },
      include: RESERVATION_INCLUDE,
    })

    return NextResponse.json({ reservations: reservations.map(serializeReservation) })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth(req, ['waiter', 'admin', 'pos', 'reservations'])
    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })

    const customerName =
      typeof body?.customerName === 'string' ? body.customerName.trim() : ''
    if (!customerName || customerName.length > 60) {
      throw new ApiError('Customer name is required (1-60 characters)', 400)
    }

    let customerPhone: string | null = null
    if (body?.customerPhone != null) {
      const raw = String(body.customerPhone).trim()
      if (raw.length > 20) throw new ApiError('Phone is too long (max 20 characters)', 400)
      customerPhone = raw || null
    }

    let partySize = 2
    if (body?.partySize != null) {
      const n = Number(body.partySize)
      if (!Number.isInteger(n) || n < 1 || n > 30) {
        throw new ApiError('Party size must be an integer between 1 and 30', 400)
      }
      partySize = n
    }

    if (body?.reservedAt == null) throw new ApiError('reservedAt is required', 400)
    const reservedAt = new Date(String(body.reservedAt))
    if (Number.isNaN(reservedAt.getTime())) {
      throw new ApiError('reservedAt must be a valid datetime', 400)
    }
    const ninetyDaysAgo = Date.now() - 90 * 24 * 3600 * 1000
    if (reservedAt.getTime() < ninetyDaysAgo) {
      throw new ApiError('reservedAt cannot be more than 90 days in the past', 400)
    }

    let notes: string | null = null
    if (body?.notes != null) {
      const raw = String(body.notes).trim()
      if (raw.length > 300) throw new ApiError('Notes are too long (max 300 characters)', 400)
      notes = raw || null
    }

    // Optional table pre-selection (validated, floor derived from the table)
    let tableId: number | null = null
    let floorPlanId: number | null = null
    if (body?.tableId != null) {
      tableId = Number(body.tableId)
      if (!Number.isInteger(tableId) || tableId <= 0) {
        throw new ApiError('Invalid tableId', 400)
      }
      const table = await db.restaurantTable.findUnique({ where: { id: tableId } })
      if (!table || !table.active) throw new ApiError('Table not found', 404)
      floorPlanId = table.floorPlanId ?? null
    } else if (body?.floorPlanId != null) {
      floorPlanId = Number(body.floorPlanId)
      if (!Number.isInteger(floorPlanId) || floorPlanId <= 0) {
        throw new ApiError('Invalid floorPlanId', 400)
      }
      const plan = await db.floorPlan.findUnique({ where: { id: floorPlanId } })
      if (!plan) throw new ApiError('Floor plan not found', 404)
    }

    const reservation = await db.reservation.create({
      data: {
        customerName,
        customerPhone,
        partySize,
        reservedAt,
        notes,
        tableId,
        floorPlanId,
        status: 'pending',
        createdBy: session.name,
      },
      include: RESERVATION_INCLUDE,
    })

    await logAudit({
      user: session,
      action: 'reservation.create',
      entity: 'reservation',
      entityId: reservation.id,
      details: `Booking for ${customerName} · ${partySize} guest(s) at ${reservedAt.toISOString()}${
        tableId ? ' (table pre-selected)' : ''
      }`,
    })

    return NextResponse.json({ reservation: serializeReservation(reservation) })
  } catch (err) {
    return errorResponse(err)
  }
}
