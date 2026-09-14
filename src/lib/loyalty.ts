// ─── R13: loyalty engine ─────────────────────────────────────────────
// Reads/writes loyalty AppSettings, awards points when an order closes,
// and redeems points as tender (payment method 'loyalty'). All money math
// rounds at the persistence boundary (round2) — same convention as orders.

import { db } from '@/lib/db'
import { ApiError } from '@/lib/auth'
import {
  LOYALTY_DEFAULTS,
  LOYALTY_EGP_PER_POINT_KEY,
  LOYALTY_ENABLED_KEY,
  LOYALTY_POINTS_PER_EGP_KEY,
} from '@/lib/constants'

/** Round to 2 decimals (same convention as lib/orders — local copy avoids a
 *  circular import with orders.ts, which now calls awardLoyaltyOnClose). */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

export type LoyaltySettings = {
  enabled: boolean
  pointsPerEgp: number
  egpPerPoint: number
}

/** Read the loyalty settings (falls back to defaults when rows are absent). */
export async function getLoyaltySettings(): Promise<LoyaltySettings> {
  const rows = await db.appSetting.findMany({
    where: {
      key: { in: [LOYALTY_ENABLED_KEY, LOYALTY_POINTS_PER_EGP_KEY, LOYALTY_EGP_PER_POINT_KEY] },
    },
  })
  const byKey = new Map(rows.map((row) => [row.key, row.value]))
  const enabled = byKey.get(LOYALTY_ENABLED_KEY) ?? String(LOYALTY_DEFAULTS.enabled)
  const pointsPerEgp = Number(byKey.get(LOYALTY_POINTS_PER_EGP_KEY) ?? LOYALTY_DEFAULTS.pointsPerEgp)
  const egpPerPoint = Number(byKey.get(LOYALTY_EGP_PER_POINT_KEY) ?? LOYALTY_DEFAULTS.egpPerPoint)
  return {
    enabled: enabled === 'true',
    pointsPerEgp: Number.isFinite(pointsPerEgp) ? pointsPerEgp : LOYALTY_DEFAULTS.pointsPerEgp,
    egpPerPoint: Number.isFinite(egpPerPoint) ? egpPerPoint : LOYALTY_DEFAULTS.egpPerPoint,
  }
}

/**
 * Award loyalty for a just-closed order: points on the paid total (net of
 * loyalty-tender), one visit, totalSpent += order total, lastVisitAt = now.
 * Caller (closeOrderIfFullyPaid) invokes this ONLY when the order actually
 * transitioned to 'paid' AND carries a customerId — awarding is idempotent
 * per close (the status guard upstream prevents a second run).
 */
export async function awardLoyaltyOnClose(orderId: number): Promise<number> {
  const settings = await getLoyaltySettings()
  if (!settings.enabled || settings.pointsPerEgp <= 0) return 0
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: { payments: true },
  })
  if (!order || order.customerId == null) return 0
  if (order.status !== 'paid') return 0
  if (order.pointsEarned > 0) return 0 // already awarded (defensive)

  const loyaltyTender = order.payments
    .filter((p) => p.method === 'loyalty')
    .reduce((sum, p) => sum + p.amount, 0)
  const earnBase = round2(Math.max(0, order.totalAmount - loyaltyTender))
  if (earnBase <= 0) return 0
  const earned = round2(earnBase * settings.pointsPerEgp)
  if (earned <= 0) return 0

  await db.$transaction([
    db.order.update({
      where: { id: orderId },
      data: { pointsEarned: earned },
    }),
    db.customer.update({
      where: { id: order.customerId },
      data: {
        points: { increment: earned },
        visits: { increment: 1 },
        totalSpent: { increment: round2(order.totalAmount) },
        lastVisitAt: new Date(),
      },
    }),
  ])
  return earned
}

/**
 * Redeem `points` from the order's customer as tender. Points are deducted
 * immediately (double-spend guard) and recorded on the order
 * (pointsRedeemed) + as a payment row (method 'loyalty', reference keeps
 * the point count for receipts). Returns the EGP value applied.
 * `reserveAmount` (optional) holds room for regular payment rows committed
 * in the SAME request — the redemption caps at the remaining balance net of
 * it, so a combined call can never overshoot the bill.
 * Validation errors throw ApiError (caller converts to JSON responses).
 */
export async function redeemLoyaltyPoints(
  orderId: number,
  points: number,
  reserveAmount = 0,
): Promise<{ egpValue: number; customerId: number; customerName: string }> {
  if (!Number.isFinite(points) || points <= 0) {
    throw new ApiError('Points to redeem must be greater than zero', 400)
  }
  const settings = await getLoyaltySettings()
  if (!settings.enabled) throw new ApiError('Loyalty program is disabled', 400)

  const order = await db.order.findUnique({
    where: { id: orderId },
    include: { payments: true, customer: true },
  })
  if (!order) throw new ApiError('Order not found', 404)
  if (order.status !== 'open' && order.status !== 'deferred') {
    throw new ApiError('Only open or deferred orders can redeem points', 400)
  }
  if (order.customerId == null || !order.customer) {
    throw new ApiError('Attach a customer to this order before redeeming points', 400)
  }
  const paidAmount = order.payments.reduce((sum, p) => sum + p.amount, 0)
  const remaining = round2(
    order.totalAmount - paidAmount - Math.max(0, reserveAmount),
  )
  if (remaining <= 0) throw new ApiError('Nothing left to pay on this order', 400)

  const available = round2(order.customer.points)
  const cappedPoints = round2(Math.min(points, available))
  if (cappedPoints <= 0) throw new ApiError('Customer has no points to redeem', 400)

  const egpValue = round2(Math.min(cappedPoints * settings.egpPerPoint, remaining))
  if (egpValue <= 0) throw new ApiError('Redeemed value rounds to zero', 400)
  const pointsUsed = round2(egpValue / settings.egpPerPoint)

  await db.$transaction([
    db.customer.update({
      where: { id: order.customerId },
      data: { points: { decrement: pointsUsed } },
    }),
    db.order.update({
      where: { id: orderId },
      data: { pointsRedeemed: round2(order.pointsRedeemed + pointsUsed) },
    }),
    db.payment.create({
      data: {
        orderId,
        method: 'loyalty',
        amount: egpValue,
        tip: 0,
        reference: `points:${pointsUsed}`,
      },
    }),
  ])
  return { egpValue, customerId: order.customerId, customerName: order.customer.name }
}
