// /api/reports/forecast — Sales forecast (clean R17 re-implementation; the
// old draft was broken dead code and was removed).
//
// History: the last 28 COMPLETE local days (excluding today) of PAID orders
// (status 'paid', closedAt inside the day). Projection: the next 7 days
// starting today — each day projects the AVERAGE of the same weekday's
// actuals across the history window (days with at least one paid order);
// a weekday with no data falls back to the overall avgDaily.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, errorResponse } from '@/lib/auth'
import { round2 } from '@/lib/orders'
import type { ForecastDay, ForecastReport } from '@/lib/types'

const HISTORY_DAYS = 28
const PROJECTION_DAYS = 7

/** Format a Date as a LOCAL 'YYYY-MM-DD' string. */
function formatLocalDate(d: Date): string {
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${mo}-${dd}`
}

/** Short English weekday label ('Sat') — the client localizes for display. */
const DAY_LABEL = new Intl.DateTimeFormat('en-US', { weekday: 'short' })
function dayLabel(d: Date): string {
  return DAY_LABEL.format(d)
}

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['admin', 'reports'])

    const now = new Date()
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const historyStart = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() - HISTORY_DAYS,
    )
    // history window: [historyStart, today) — 28 complete days, today excluded
    const historyEnd = today

    const orders = await db.order.findMany({
      where: { status: 'paid', closedAt: { gte: historyStart, lt: historyEnd } },
      select: { closedAt: true, totalAmount: true },
    })

    // per-day totals (local calendar days)
    const dayTotals = new Map<string, number>()
    for (const order of orders) {
      if (order.closedAt === null) continue // defensive; where-clause guarantees it
      const key = formatLocalDate(order.closedAt)
      dayTotals.set(key, (dayTotals.get(key) ?? 0) + order.totalAmount)
    }

    // ── history: 28 zero-filled days ──────────────────────────────────
    const history: ForecastDay[] = []
    const weekdayActuals: number[][] = Array.from({ length: 7 }, () => [])
    let totalActual = 0
    let daysWithData = 0
    for (let i = HISTORY_DAYS; i >= 1; i--) {
      const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i)
      const date = formatLocalDate(day)
      const actual = round2(dayTotals.get(date) ?? 0)
      history.push({ date, dayLabel: dayLabel(day), actual, projected: null })
      totalActual += actual
      if (actual > 0) {
        daysWithData += 1
        weekdayActuals[day.getDay()].push(actual)
      }
    }

    const avgDaily = daysWithData > 0 ? round2(totalActual / daysWithData) : 0

    // ── projection: today + 6 days, same-weekday average ─────────────
    const projection: ForecastDay[] = []
    let projectedWeekRaw = 0
    for (let i = 0; i < PROJECTION_DAYS; i++) {
      const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i)
      const sameWeekday = weekdayActuals[day.getDay()]
      const projected =
        sameWeekday.length > 0
          ? round2(sameWeekday.reduce((sum, v) => sum + v, 0) / sameWeekday.length)
          : avgDaily
      projectedWeekRaw += projected
      projection.push({
        date: formatLocalDate(day),
        dayLabel: dayLabel(day),
        actual: null,
        projected,
      })
    }

    const report: ForecastReport = {
      from: history.length > 0 ? history[0].date : formatLocalDate(historyStart),
      to: projection.length > 0 ? projection[projection.length - 1].date : formatLocalDate(today),
      history,
      projection,
      avgDaily,
      projectedWeekTotal: round2(projectedWeekRaw),
    }

    return NextResponse.json(report)
  } catch (err) {
    return errorResponse(err)
  }
}
