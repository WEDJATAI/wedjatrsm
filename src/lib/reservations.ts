// ─── R11: Reservations — shared include + serializer ─────────────────
// Mirrors the ORDER_INCLUDE / serializeOrder pattern from lib/orders.

import type { Prisma } from '@prisma/client'
import type { Reservation } from '@/lib/types'

export const RESERVATION_INCLUDE = {
  floorPlan: { select: { id: true, name: true } },
  table: { select: { id: true, name: true } },
  order: { select: { id: true, status: true, totalAmount: true } },
} satisfies Prisma.ReservationInclude

export type ReservationWithRelations = Prisma.ReservationGetPayload<{
  include: typeof RESERVATION_INCLUDE
}>

/** Stored statuses that mean the linked order is finished. */
const CLOSED_ORDER_STATUSES = new Set(['paid', 'merged', 'cancelled'])

/**
 * Map a loaded reservation to the API payload. NOTE on status: `completed`
 * is DERIVED — a 'seated' reservation whose linked order has closed shows
 * as completed without a write (the stored status stays 'seated').
 */
export function serializeReservation(reservation: ReservationWithRelations): Reservation {
  const effectiveStatus =
    reservation.status === 'seated' &&
    reservation.order != null &&
    CLOSED_ORDER_STATUSES.has(reservation.order.status)
      ? 'completed'
      : reservation.status
  return {
    id: reservation.id,
    customerName: reservation.customerName,
    customerPhone: reservation.customerPhone,
    partySize: reservation.partySize,
    floorPlanId: reservation.floorPlanId,
    floorPlan: reservation.floorPlan,
    tableId: reservation.tableId,
    table: reservation.table,
    reservedAt: reservation.reservedAt.toISOString(),
    status: effectiveStatus,
    notes: reservation.notes,
    orderId: reservation.orderId,
    order: reservation.order,
    createdBy: reservation.createdBy,
    createdAt: reservation.createdAt.toISOString(),
    updatedAt: reservation.updatedAt.toISOString(),
  }
}
