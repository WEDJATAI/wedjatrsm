// /api/reports/zreport — end-of-day Z-Report (cash reconciliation)
// Mirrors the sales report's conventions (local-time day windows, Float money
// rounded with round2, byMethod grouping). GET ?date=YYYY-MM-DD (default: today
// in the SERVER's local timezone). deferredOutstanding is a LIVE snapshot of
// all outstanding deferred checks regardless of the requested date.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, errorResponse, ApiError } from '@/lib/auth'
import { round2 } from '@/lib/orders'
import { MONEY_EPSILON } from '@/lib/constants'
import type { ZReport } from '@/lib/types'

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Parse 'YYYY-MM-DD' into a LOCAL-time Date (avoids the UTC shift of new Date(str)); null on garbage. */
function parseLocalDate(s: string): Date | null {
  const m = DATE_RE.exec(s)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const dt = new Date(y, mo - 1, d)
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null
  return dt
}

/** Format a Date as a LOCAL 'YYYY-MM-DD' string. */
function formatLocalDate(d: Date): string {
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${mo}-${dd}`
}

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['admin', 'reports'])

    const sp = new URL(req.url).searchParams
    const dateRaw = sp.get('date')

    let dayStart: Date
    if (dateRaw !== null && dateRaw !== '') {
      const parsed = parseLocalDate(dateRaw)
      if (!parsed) throw new ApiError('Invalid date: expected YYYY-MM-DD', 400)
      dayStart = parsed
    } else {
      const now = new Date()
      dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    }
    const date = formatLocalDate(dayStart)
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000) // start + 24h

    // 1. Orders CLOSED (paid) in the window — the day's sales.
    const closed = await db.order.findMany({
      where: { status: 'paid', closedAt: { gte: dayStart, lt: dayEnd } },
      select: {
        guests: true,
        subtotalAmount: true,
        discountAmount: true,
        taxAmount: true,
        serviceTaxAmount: true,
        totalAmount: true,
        userId: true,
        user: { select: { name: true } },
      },
    })

    const ordersClosed = closed.length
    let covers = 0
    let grossSubtotalRaw = 0
    let discountsRaw = 0
    let vatRaw = 0
    let serviceTaxRaw = 0
    let netTotalRaw = 0
    const waiterAgg = new Map<
      number | null,
      { userId: number | null; name: string; orders: number; net: number }
    >()

    for (const order of closed) {
      covers += order.guests ?? 0
      grossSubtotalRaw += order.subtotalAmount
      discountsRaw += order.discountAmount
      vatRaw += order.taxAmount
      serviceTaxRaw += order.serviceTaxAmount
      netTotalRaw += order.totalAmount

      const waiter = waiterAgg.get(order.userId) ?? {
        userId: order.userId,
        name: '—',
        orders: 0,
        net: 0,
      }
      // keep the first real user name seen for this userId (deleted users → '—')
      if (waiter.name === '—' && order.user?.name) waiter.name = order.user.name
      waiter.orders += 1
      waiter.net += order.totalAmount
      waiterAgg.set(order.userId, waiter)
    }

    const byWaiter = Array.from(waiterAgg.values())
      .map((w) => ({ ...w, net: round2(w.net) }))
      .sort((a, b) => b.net - a.net)

    // 2. Orders cancelled in the window. The cancel route maintains closedAt
    //    (set on cancel); createdAt is the fallback for legacy rows only.
    const cancelledCount = await db.order.count({
      where: {
        status: 'cancelled',
        OR: [
          { closedAt: { gte: dayStart, lt: dayEnd } },
          { closedAt: null, createdAt: { gte: dayStart, lt: dayEnd } },
        ],
      },
    })

    // 3 + 4. Payments received in the window (incl. settlements of deferred
    //    checks — parent order keeps clientName even after closing).
    const payments = await db.payment.findMany({
      where: { createdAt: { gte: dayStart, lt: dayEnd } },
      select: { method: true, amount: true, order: { select: { clientName: true } } },
    })

    const methodAgg = new Map<string, { amount: number; count: number }>()
    let paymentsTotalRaw = 0
    let deferredSettledRaw = 0
    for (const payment of payments) {
      paymentsTotalRaw += payment.amount

      const agg = methodAgg.get(payment.method) ?? { amount: 0, count: 0 }
      agg.amount += payment.amount
      agg.count += 1
      methodAgg.set(payment.method, agg)

      if (payment.order.clientName != null) deferredSettledRaw += payment.amount
    }

    // Only methods that actually took payments (same behavior as the sales
    // report's byMethod), biggest amount first.
    const paymentsByMethod = Array.from(methodAgg.entries())
      .map(([method, v]) => ({ method, amount: round2(v.amount), count: v.count }))
      .sort((a, b) => b.amount - a.amount)

    // 5. Deferred outstanding — LIVE liability snapshot (all deferred checks,
    //    regardless of date), remainder rounded per order then summed.
    const deferredOrders = await db.order.findMany({
      where: { status: 'deferred' },
      select: { totalAmount: true, payments: { select: { amount: true } } },
    })
    let deferredOutstanding = 0
    for (const order of deferredOrders) {
      const paid = order.payments.reduce((sum, p) => sum + p.amount, 0)
      const remainder = round2(order.totalAmount - paid)
      // remainders within the money tolerance count as settled
      if (remainder > MONEY_EPSILON) deferredOutstanding += remainder
    }
    deferredOutstanding = round2(deferredOutstanding)

    const report: ZReport = {
      date,
      ordersClosed,
      covers,
      grossSubtotal: round2(grossSubtotalRaw),
      discounts: round2(discountsRaw),
      vat: round2(vatRaw),
      serviceTax: round2(serviceTaxRaw),
      netTotal: round2(netTotalRaw),
      avgCheck: ordersClosed > 0 ? round2(netTotalRaw / ordersClosed) : 0,
      cancelledCount,
      paymentsByMethod,
      paymentsTotal: round2(paymentsTotalRaw),
      deferredSettled: round2(deferredSettledRaw),
      deferredOutstanding,
      byWaiter,
    }

    return NextResponse.json({ report })
  } catch (err) {
    return errorResponse(err)
  }
}
