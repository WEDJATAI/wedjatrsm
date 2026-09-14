// /api/reservations/[id] — booking board (R11)
// PUT (waiter/admin/pos/reservations): edit a PENDING booking's details, or
// transition its status (pending → cancelled | no_show). Seating happens via
// the dedicated /seat endpoint; 'seated' → 'completed' is derived from the
// linked order and cannot be set manually.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { RESERVATION_STATUSES } from '@/lib/constants'
import {
  RESERVATION_INCLUDE,
  serializeReservation,
} from '@/lib/reservations'

type Ctx = { params: Promise<{ id: string }> }

function parseIdParam(id: string): number {
  const n = Number(id)
  if (!Number.isInteger(n) || n <= 0) throw new ApiError('Invalid reservation id', 400)
  return n
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  try {
    const session = await requireAuth(req, ['waiter', 'admin', 'pos', 'reservations'])
    const { id } = await ctx.params
    const reservationId = parseIdParam(id)

    const existing = await db.reservation.findUnique({
      where: { id: reservationId },
    })
    if (!existing) throw new ApiError('Reservation not found', 404)

    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })

    // ── Status transition (optional) ──────────────────────────────────
    let nextStatus: string | null = null
    if (body?.status != null) {
      const raw = String(body.status)
      if (!(RESERVATION_STATUSES as readonly string[]).includes(raw)) {
        throw new ApiError(`Invalid status "${raw}"`, 400)
      }
      const allowed: Record<string, string[]> = {
        pending: ['cancelled', 'no_show'],
        seated: [], // completed is derived from the linked order
        completed: [],
        cancelled: [],
        no_show: [],
      }
      if (!(allowed[existing.status] ?? []).includes(raw)) {
        throw new ApiError(
          `Cannot change a ${existing.status} reservation to ${raw}`,
          409,
        )
      }
      nextStatus = raw
    }

    // ── Field edits (pending bookings only) ───────────────────────────
    const data: Record<string, unknown> = {}

    if (body?.customerName !== undefined) {
      const name = String(body.customerName).trim()
      if (!name || name.length > 60) {
        throw new ApiError('Customer name is required (1-60 characters)', 400)
      }
      data.customerName = name
    }
    if (body?.customerPhone !== undefined) {
      const raw = String(body.customerPhone).trim()
      if (raw.length > 20) throw new ApiError('Phone is too long (max 20 characters)', 400)
      data.customerPhone = raw || null
    }
    if (body?.partySize !== undefined) {
      const n = Number(body.partySize)
      if (!Number.isInteger(n) || n < 1 || n > 30) {
        throw new ApiError('Party size must be an integer between 1 and 30', 400)
      }
      data.partySize = n
    }
    if (body?.reservedAt !== undefined) {
      const d = new Date(String(body.reservedAt))
      if (Number.isNaN(d.getTime())) {
        throw new ApiError('reservedAt must be a valid datetime', 400)
      }
      data.reservedAt = d
    }
    if (body?.notes !== undefined) {
      const raw = String(body.notes).trim()
      if (raw.length > 300) throw new ApiError('Notes are too long (max 300 characters)', 400)
      data.notes = raw || null
    }
    if (body?.tableId !== undefined) {
      if (body.tableId === null) {
        data.tableId = null
        data.floorPlanId = null
      } else {
        const tableId = Number(body.tableId)
        if (!Number.isInteger(tableId) || tableId <= 0) {
          throw new ApiError('Invalid tableId', 400)
        }
        const table = await db.restaurantTable.findUnique({ where: { id: tableId } })
        if (!table || !table.active) throw new ApiError('Table not found', 404)
        data.tableId = tableId
        data.floorPlanId = table.floorPlanId ?? null
      }
    }

    const fieldKeys = Object.keys(data)
    if (fieldKeys.length > 0 && existing.status !== 'pending' && nextStatus === null) {
      throw new ApiError('Only pending reservations can be edited', 409)
    }
    if (nextStatus !== null) data.status = nextStatus

    if (Object.keys(data).length === 0) {
      // nothing to do — return current state
      const unchanged = await db.reservation.findUnique({
        where: { id: reservationId },
        include: RESERVATION_INCLUDE,
      })
      return NextResponse.json({ reservation: serializeReservation(unchanged!) })
    }

    const updated = await db.reservation.update({
      where: { id: reservationId },
      data,
      include: RESERVATION_INCLUDE,
    })

    await logAudit({
      user: session,
      action:
        nextStatus === 'cancelled'
          ? 'reservation.cancel'
          : nextStatus === 'no_show'
            ? 'reservation.noShow'
            : 'reservation.update',
      entity: 'reservation',
      entityId: reservationId,
      details: nextStatus
        ? `Booking for ${updated.customerName} marked ${nextStatus.replace('_', '-')}`
        : `Booking for ${updated.customerName} updated (${fieldKeys.join(', ')})`,
    })

    return NextResponse.json({ reservation: serializeReservation(updated) })
  } catch (err) {
    return errorResponse(err)
  }
}
