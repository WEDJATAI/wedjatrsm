/**
 * R23: Daily sales digest + stale-order alert — shared by the Vercel cron
 * endpoints (/api/cron/*) and the Inngest scheduled functions, so the same
 * logic runs regardless of which scheduler fires first (all idempotent).
 */
import { db } from '@/lib/db'
import { logAudit } from '@/lib/audit'

export type DailyDigest = {
  date: string
  orderCount: number
  guests: number
  subtotal: number
  gross: number
  tax: number
  serviceTax: number
  discounts: number
  tips: number
  paymentsByMethod: Record<string, number>
  topServers: Array<{ name: string; orders: number; gross: number }>
  /** true when a digest for this date was already recorded (idempotent skip) */
  skipped?: boolean
}

function dayBounds(date: string): { from: Date; to: Date } {
  const from = new Date(`${date}T00:00:00.000Z`)
  return { from, to: new Date(from.getTime() + 24 * 60 * 60 * 1000) }
}

/**
 * Compute + record yesterday's sales digest (or an explicit UTC date).
 * Idempotent: an existing `report.dailyDigest` audit row for the date makes
 * this a no-op (both schedulers can fire without double entries).
 */
export async function runDailyDigest(dateOverride?: string): Promise<DailyDigest> {
  const date = dateOverride ?? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  const empty: DailyDigest = {
    date,
    orderCount: 0,
    guests: 0,
    subtotal: 0,
    gross: 0,
    tax: 0,
    serviceTax: 0,
    discounts: 0,
    tips: 0,
    paymentsByMethod: {},
    topServers: [],
  }

  // idempotency gate
  const existing = await db.auditLog.findFirst({
    where: { action: 'report.dailyDigest', details: { contains: `date=${date}` } },
    select: { id: true },
  })
  if (existing) return { ...empty, skipped: true }

  const { from, to } = dayBounds(date)
  const orders = await db.order.findMany({
    where: { status: 'paid', closedAt: { gte: from, lt: to } },
    include: { user: { select: { name: true } }, payments: true },
  })

  const byServer = new Map<string, { orders: number; gross: number }>()
  for (const o of orders) {
    const key = o.user?.name ?? 'unassigned'
    const cur = byServer.get(key) ?? { orders: 0, gross: 0 }
    cur.orders += 1
    cur.gross += o.totalAmount
    byServer.set(key, cur)
  }

  const digest: DailyDigest = {
    date,
    orderCount: orders.length,
    guests: orders.reduce((s, o) => s + o.guests, 0),
    subtotal: orders.reduce((s, o) => s + o.subtotalAmount, 0),
    gross: orders.reduce((s, o) => s + o.totalAmount, 0),
    tax: orders.reduce((s, o) => s + o.taxAmount, 0),
    serviceTax: orders.reduce((s, o) => s + o.serviceTaxAmount, 0),
    discounts: orders.reduce((s, o) => s + o.discountAmount, 0),
    tips: orders.reduce((s, o) => s + o.payments.reduce((t, p) => t + p.tip, 0), 0),
    paymentsByMethod: orders.reduce<Record<string, number>>((acc, o) => {
      for (const p of o.payments) acc[p.method] = (acc[p.method] ?? 0) + p.amount
      return acc
    }, {}),
    topServers: [...byServer.entries()]
      .map(([name, v]) => ({ name, ...v }))
      .sort((a, b) => b.gross - a.gross)
      .slice(0, 3),
  }

  await logAudit({
    user: null,
    action: 'report.dailyDigest',
    entity: 'report',
    details:
      `date=${date} orders=${digest.orderCount} guests=${digest.guests} ` +
      `gross=${digest.gross.toFixed(2)} tax=${digest.tax.toFixed(2)} ` +
      `serviceTax=${digest.serviceTax.toFixed(2)} discounts=${digest.discounts.toFixed(2)} ` +
      `tips=${digest.tips.toFixed(2)} ` +
      `payments=${JSON.stringify(digest.paymentsByMethod)} ` +
      `top=${digest.topServers.map((s) => `${s.name}:${s.orders}/${s.gross.toFixed(0)}`).join(', ')}`,
  })

  return digest
}

export type StaleOrderAlert = {
  checked: boolean
  staleOrderIds: number[]
  alerted: boolean
  reason?: string
}

/**
 * Detect open orders whose items have been "preparing" for > 45 minutes and
 * record an alert (deduped: at most one alert row per ~29 minutes).
 */
export async function runStaleOrderAlert(): Promise<StaleOrderAlert> {
  const threshold = new Date(Date.now() - 45 * 60 * 1000)

  // recent alert within 29 min → skip (the */30 scheduler never double-fires)
  const recent = await db.auditLog.findFirst({
    where: { action: 'alert.staleOrders', createdAt: { gte: new Date(Date.now() - 29 * 60 * 1000) } },
    select: { id: true },
  })
  if (recent) {
    return { checked: false, staleOrderIds: [], alerted: false, reason: 'dedupe: alert already recorded in the last 29 minutes' }
  }

  const staleItems = await db.orderItem.findMany({
    where: { status: 'preparing', createdAt: { lt: threshold }, order: { status: 'open' } },
    select: { orderId: true },
    distinct: ['orderId'],
  })
  const staleOrderIds = [...new Set(staleItems.map((i) => i.orderId))].sort((a, b) => a - b)

  if (staleOrderIds.length === 0) {
    return { checked: true, staleOrderIds: [], alerted: false, reason: 'no stale orders' }
  }

  await logAudit({
    user: null,
    action: 'alert.staleOrders',
    entity: 'order',
    details: `items stuck in "preparing" > 45 min on open orders: ${staleOrderIds.map((id) => `#${id}`).join(', ')}`,
  })
  return { checked: true, staleOrderIds, alerted: true }
}
