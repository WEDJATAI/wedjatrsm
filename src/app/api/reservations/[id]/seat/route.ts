// /api/reservations/[id]/seat — booking board (R11)
// POST (waiter/admin/pos/reservations): seat a PENDING booking at a table.
// Marks the table 'reserved' (the floor shows the party is expected) and the
// reservation 'seated'. The open ORDER itself is created through the normal
// POS flow (Seat Party → send items); lib/orders auto-links it to this
// reservation when it lands on the same table.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { findOpenOrderOnTable } from '@/lib/orders'
import { RESERVATION_INCLUDE, serializeReservation } from '@/lib/reservations'

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const session = await requireAuth(req, ['waiter', 'admin', 'pos', 'reservations'])
    const { id } = await ctx.params
    const reservationId = Number(id)
    if (!Number.isInteger(reservationId) || reservationId <= 0) {
      throw new ApiError('Invalid reservation id', 400)
    }

    const existing = await db.reservation.findUnique({
      where: { id: reservationId },
    })
    if (!existing) throw new ApiError('Reservation not found', 404)
    if (existing.status !== 'pending') {
      throw new ApiError(`Only pending reservations can be seated (this one is ${existing.status})`, 409)
    }

    const body = await req.json().catch(() => ({}))
    const requestedTableId: number | null =
      body?.tableId != null ? Number(body.tableId) : existing.tableId
    if (
      !Number.isInteger(requestedTableId) ||
      requestedTableId == null ||
      requestedTableId <= 0
    ) {
      throw new ApiError('A table is required to seat a reservation', 400)
    }
    const seatTableId: number = requestedTableId

    // Validate the table: exists, active, free of open orders and not dirty.
    const table = await db.restaurantTable.findUnique({ where: { id: seatTableId } })
    if (!table || !table.active) throw new ApiError('Table not found', 404)
    const openOrder = await findOpenOrderOnTable(table.id)
    if (openOrder) {
      throw new ApiError(`Table "${table.name}" already has an open order`, 409)
    }
    if (table.status === 'dirty') {
      throw new ApiError(`Table "${table.name}" needs cleaning before seating`, 409)
    }

    const updated = await db.reservation.update({
      where: { id: reservationId },
      data: {
        status: 'seated',
        tableId: table.id,
        floorPlanId: table.floorPlanId ?? existing.floorPlanId,
      },
      include: RESERVATION_INCLUDE,
    })
    await db.restaurantTable.update({
      where: { id: table.id },
      data: { status: 'reserved' },
    })

    await logAudit({
      user: session,
      action: 'reservation.seat',
      entity: 'reservation',
      entityId: reservationId,
      details: `${updated.customerName} · ${updated.partySize} guest(s) seated at table ${table.name}`,
    })

    return NextResponse.json({ reservation: serializeReservation(updated) })
  } catch (err) {
    return errorResponse(err)
  }
}
