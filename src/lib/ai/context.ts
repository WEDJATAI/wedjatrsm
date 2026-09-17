// ─── AI business snapshot (server-only) ─────────────────────────────
// Builds a compact, LLM-friendly snapshot of the restaurant state from
// the live DB for the copilot + briefing prompts. Day boundaries mirror
// the Z-report convention: SERVER-LOCAL midnight → +24h. Revenue is
// recognized on the day a check CLOSED (closedAt, like the Z-report's
// netTotal); operational counts (open checks, items, waiters) use the
// orders CREATED today. Payments/tips follow the Z-report payment set
// (payment.createdAt within the day window).

import { db } from '@/lib/db'
import { round2 } from '@/lib/orders'

// ─── Types ──────────────────────────────────────────────────────────

export type SnapshotPaymentMix = { method: string; amount: number; count: number }
export type SnapshotTopItem = { name: string; qty: number; revenue: number }
export type SnapshotWaiter = { name: string; orders: number; netSales: number; tips: number }
export type SnapshotLowStock = { name: string; stock: number; lowStockThreshold: number }
export type SnapshotTableState = {
  total: number
  free: number
  occupied: number
  reserved: number
  bussing: number // status 'paid' — bill settled, awaiting bussing
  deferred: number
  dirty: number
}
export type SnapshotDayRevenue = { date: string; revenue: number; orders: number }
export type SnapshotForecast = {
  weekday: string
  avgRevenue: number
  sampleDays: number
}

export type BusinessSnapshot = {
  generatedAt: string
  date: string // YYYY-MM-DD (server-local)
  time: string // HH:MM (server-local)
  revenueToday: number // Σ totalAmount of checks closed today
  paidOrdersToday: number
  openOrdersToday: number
  deferredOrdersToday: number
  ordersToday: number // non-cancelled orders created today (open+paid+deferred)
  paidCreatedToday: number // of today's created orders, already settled
  avgCheck: number
  tipsToday: number
  guestsToday: number
  paymentMix: SnapshotPaymentMix[]
  topItems: SnapshotTopItem[]
  waiters: SnapshotWaiter[]
  lowStock: SnapshotLowStock[]
  tables: SnapshotTableState
  last7Days: SnapshotDayRevenue[]
  forecast: SnapshotForecast
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Format a local Date as 'YYYY-MM-DD' (same as the Z-report helper). */
function formatLocalDate(d: Date): string {
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${mo}-${dd}`
}

/** EGP money label with Latin digits + thousands separators. */
function egp(n: number): string {
  const v = Number.isFinite(n) ? n : 0
  return `EGP ${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** Quantity label (Float quantities trimmed of trailing .00). */
function qty(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.?0+$/, '')
}

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]

// ─── Snapshot builder ───────────────────────────────────────────────

export async function buildBusinessSnapshot(): Promise<BusinessSnapshot> {
  const now = new Date()
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000)
  const todayKey = formatLocalDate(dayStart)

  // 1) Operational orders — CREATED today, non-cancelled (open/paid/deferred).
  const ordersToday = await db.order.findMany({
    where: { createdAt: { gte: dayStart, lt: dayEnd }, status: { in: ['open', 'paid', 'deferred'] } },
    select: {
      status: true,
      guests: true,
      totalAmount: true,
      userId: true,
      user: { select: { name: true } },
      items: {
        select: {
          quantity: true,
          unitPrice: true,
          product: { select: { name: true } },
        },
      },
    },
  })

  let openOrdersToday = 0
  let deferredOrdersToday = 0
  let paidCreatedToday = 0
  let guestsToday = 0
  const waiterAgg = new Map<
    number | null,
    { name: string; orders: number; netSales: number }
  >()
  const itemAgg = new Map<string, { qty: number; revenue: number }>()

  for (const order of ordersToday) {
    if (order.status === 'open') openOrdersToday += 1
    else if (order.status === 'deferred') deferredOrdersToday += 1
    else paidCreatedToday += 1
    guestsToday += order.guests ?? 0

    const waiter = waiterAgg.get(order.userId) ?? {
      name: order.user?.name ?? '—',
      orders: 0,
      netSales: 0,
    }
    if (waiter.name === '—' && order.user?.name) waiter.name = order.user.name
    waiter.orders += 1
    waiter.netSales += order.totalAmount
    waiterAgg.set(order.userId, waiter)

    for (const item of order.items) {
      const name = item.product?.name ?? 'Unknown item'
      const agg = itemAgg.get(name) ?? { qty: 0, revenue: 0 }
      agg.qty += item.quantity
      agg.revenue += item.quantity * item.unitPrice
      itemAgg.set(name, agg)
    }
  }

  // 2) Day revenue — checks CLOSED today (Z-report netTotal convention).
  const closedToday = await db.order.findMany({
    where: { status: 'paid', closedAt: { gte: dayStart, lt: dayEnd } },
    select: { totalAmount: true },
  })
  const revenueToday = closedToday.reduce((s, o) => s + o.totalAmount, 0)
  const paidOrdersToday = closedToday.length

  // 3) Payments received today (Z-report payment set): method mix + tips
  //    + per-waiter tips (payments on that waiter's orders).
  const paymentsToday = await db.payment.findMany({
    where: { createdAt: { gte: dayStart, lt: dayEnd } },
    select: {
      method: true,
      amount: true,
      tip: true,
      order: { select: { userId: true, user: { select: { name: true } } } },
    },
  })
  const methodAgg = new Map<string, { amount: number; count: number }>()
  let tipsToday = 0
  const waiterTips = new Map<number | null, number>()
  const waiterTipNames = new Map<number | null, string>()
  for (const p of paymentsToday) {
    const agg = methodAgg.get(p.method) ?? { amount: 0, count: 0 }
    agg.amount += p.amount
    agg.count += 1
    methodAgg.set(p.method, agg)
    tipsToday += p.tip ?? 0
    waiterTips.set(p.order.userId, (waiterTips.get(p.order.userId) ?? 0) + (p.tip ?? 0))
    if (p.order.user?.name) waiterTipNames.set(p.order.userId, p.order.user.name)
  }
  // Waiters with tips today but no orders created today still get a row.
  for (const [waiterId, tip] of waiterTips) {
    if (waiterAgg.has(waiterId) || round2(tip) <= 0) continue
    waiterAgg.set(waiterId, {
      name: waiterTipNames.get(waiterId) ?? '—',
      orders: 0,
      netSales: 0,
    })
  }

  // 4) Inventory: stockable products at/below their low-stock threshold
  //    (column-to-column compare is unsupported by Prisma → JS filter,
  //    same approach as /api/inventory/low-stock).
  const stockable = await db.product.findMany({
    where: { isStockable: true, active: true },
    select: { name: true, stock: true, lowStockThreshold: true },
    orderBy: { name: 'asc' },
  })
  const lowStock = stockable
    .filter((p) => p.stock <= p.lowStockThreshold)
    .map((p) => ({
      name: p.name,
      stock: round2(p.stock),
      lowStockThreshold: round2(p.lowStockThreshold),
    }))

  // 5) Live table state (active tables only).
  const tables = await db.restaurantTable.findMany({
    where: { active: true },
    select: { status: true },
  })
  const tableState: SnapshotTableState = {
    total: tables.length,
    free: 0,
    occupied: 0,
    reserved: 0,
    bussing: 0,
    deferred: 0,
    dirty: 0,
  }
  for (const t of tables) {
    if (t.status === 'free') tableState.free += 1
    else if (t.status === 'occupied') tableState.occupied += 1
    else if (t.status === 'reserved') tableState.reserved += 1
    else if (t.status === 'paid') tableState.bussing += 1
    else if (t.status === 'deferred') tableState.deferred += 1
    else if (t.status === 'dirty') tableState.dirty += 1
  }

  // 6) Full paid-order history (SQLite-local, small) → 7-day series +
  //    same-weekday forecast for tomorrow.
  const paidHistory = await db.order.findMany({
    where: { status: 'paid' },
    select: { closedAt: true, totalAmount: true },
  })
  const daily = new Map<string, { revenue: number; orders: number }>()
  for (const o of paidHistory) {
    if (!o.closedAt) continue
    const key = formatLocalDate(o.closedAt)
    const agg = daily.get(key) ?? { revenue: 0, orders: 0 }
    agg.revenue += o.totalAmount
    agg.orders += 1
    daily.set(key, agg)
  }
  const last7Days: SnapshotDayRevenue[] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(dayStart.getTime() - i * 24 * 60 * 60 * 1000)
    const key = formatLocalDate(d)
    const agg = daily.get(key)
    last7Days.push({
      date: key,
      revenue: round2(agg?.revenue ?? 0),
      orders: agg?.orders ?? 0,
    })
  }

  // Tomorrow's weekday + average revenue of that weekday over complete
  // history days (today excluded — it is still partial).
  const tomorrow = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000)
  const targetWeekday = tomorrow.getDay()
  let weekdayRevenue = 0
  let sampleDays = 0
  for (const [key, agg] of daily) {
    if (key === todayKey) continue // partial day — skip
    const d = new Date(`${key}T12:00:00`) // local-noon parse (no UTC shift)
    if (d.getDay() === targetWeekday) {
      weekdayRevenue += agg.revenue
      sampleDays += 1
    }
  }

  return {
    generatedAt: now.toISOString(),
    date: todayKey,
    time: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    revenueToday: round2(revenueToday),
    paidOrdersToday,
    openOrdersToday,
    deferredOrdersToday,
    ordersToday: ordersToday.length,
    paidCreatedToday,
    avgCheck: paidOrdersToday > 0 ? round2(revenueToday / paidOrdersToday) : 0,
    tipsToday: round2(tipsToday),
    guestsToday,
    paymentMix: Array.from(methodAgg.entries())
      .map(([method, v]) => ({ method, amount: round2(v.amount), count: v.count }))
      .sort((a, b) => b.amount - a.amount),
    topItems: Array.from(itemAgg.entries())
      .map(([name, v]) => ({ name, qty: round2(v.qty), revenue: round2(v.revenue) }))
      .sort((a, b) => b.qty - a.qty)
      .slice(0, 8),
    waiters: Array.from(waiterAgg.entries())
      .map(([userId, w]) => ({
        name: w.name,
        orders: w.orders,
        netSales: round2(w.netSales),
        tips: round2(waiterTips.get(userId) ?? 0),
      }))
      .sort((a, b) => b.netSales - a.netSales),
    lowStock,
    tables: tableState,
    last7Days,
    forecast: {
      weekday: WEEKDAYS[targetWeekday] ?? 'tomorrow',
      avgRevenue: sampleDays > 0 ? round2(weekdayRevenue / sampleDays) : 0,
      sampleDays,
    },
  }
}

// ─── LLM context rendering ──────────────────────────────────────────

/**
 * Render the snapshot as compact markdown-ish text for the LLM context.
 * EGP amounts, Latin digits, short lines (token-efficient).
 */
export function renderSnapshot(s: BusinessSnapshot): string {
  const lines: string[] = []
  lines.push(`SNAPSHOT — ${s.date} ${s.time} (server time)`)
  lines.push(
    `TODAY: ${s.ordersToday} orders created (${s.openOrdersToday} open, ${s.paidCreatedToday} paid, ${s.deferredOrdersToday} deferred), ${s.guestsToday} guests`,
  )
  lines.push(
    `REVENUE TODAY: ${egp(s.revenueToday)} from ${s.paidOrdersToday} closed checks, avg check ${egp(s.avgCheck)}, tips ${egp(s.tipsToday)}`,
  )
  if (s.paymentMix.length > 0) {
    lines.push(
      `PAYMENTS TODAY: ${s.paymentMix
        .map((m) => `${m.method} ${egp(m.amount)} (${m.count})`)
        .join(', ')}`,
    )
  } else {
    lines.push('PAYMENTS TODAY: none yet')
  }
  if (s.topItems.length > 0) {
    lines.push(
      `TOP ITEMS TODAY (by qty): ${s.topItems
        .map((t) => `${t.name} x${qty(t.qty)} (${egp(t.revenue)})`)
        .join(', ')}`,
    )
  } else {
    lines.push('TOP ITEMS TODAY: none yet')
  }
  if (s.waiters.length > 0) {
    lines.push(
      `WAITERS TODAY: ${s.waiters
        .map(
          (w) =>
            `${w.name} — ${w.orders} orders, net ${egp(w.netSales)}, tips ${egp(w.tips)}`,
        )
        .join('; ')}`,
    )
  }
  const t = s.tables
  lines.push(
    `TABLES (active ${t.total}): ${t.free} free, ${t.occupied} occupied, ${t.reserved} reserved, ${t.bussing} awaiting bussing, ${t.deferred} deferred, ${t.dirty} dirty`,
  )
  if (s.lowStock.length > 0) {
    lines.push(
      `LOW STOCK (<= threshold): ${s.lowStock
        .map((i) => `${i.name} ${qty(i.stock)} (min ${qty(i.lowStockThreshold)})`)
        .join(', ')}`,
    )
  } else {
    lines.push('LOW STOCK: none')
  }
  lines.push(
    `LAST 7 DAYS REVENUE (by close date, today partial): ${s.last7Days
      .map((d) => `${d.date}: ${egp(d.revenue)} (${d.orders} checks)`)
      .join(' | ')}`,
  )
  const f = s.forecast
  lines.push(
    f.sampleDays > 0
      ? `FORECAST: tomorrow is ${f.weekday}; same-weekday historical average ${egp(f.avgRevenue)} over ${f.sampleDays} day(s)`
      : `FORECAST: tomorrow is ${f.weekday}; no same-weekday history yet`,
  )
  return lines.join('\n')
}