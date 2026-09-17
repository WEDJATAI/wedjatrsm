// /api/reports/payroll — Payroll-lite (Odoo HR): attendance hours × hourly
// rate per team member for one calendar month. GET ?month=YYYY-MM (default:
// current month in the SERVER's local timezone).
//
// Window: local first-of-month → first-of-next-month (exclusive end).
// A session contributes when it OVERLAPS the window (checkIn < windowEnd and
// (still open OR checkOut > windowStart)); its hours are clipped to the
// window, and an OPEN session only accrues up to `now`. Users without an
// hourly rate (or without overlapping sessions) are omitted — the UI shows
// the noRateHint telling admins to set rates in Users.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, errorResponse, ApiError } from '@/lib/auth'
import { round2 } from '@/lib/orders'
import type { PayrollLine, PayrollReport } from '@/lib/types'

const MONTH_RE = /^(\d{4})-(\d{2})$/
const MS_PER_HOUR = 3_600_000

/** Parse 'YYYY-MM' into a LOCAL-time first-of-month Date; null on garbage. */
function parseLocalMonth(s: string): Date | null {
  const m = MONTH_RE.exec(s)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  if (mo < 1 || mo > 12) return null
  const dt = new Date(y, mo - 1, 1)
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1) return null
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
    await requireAuth(req, ['admin', 'payroll'])

    const sp = new URL(req.url).searchParams
    const monthRaw = sp.get('month')

    let windowStart: Date
    if (monthRaw !== null && monthRaw !== '') {
      const parsed = parseLocalMonth(monthRaw)
      if (!parsed) throw new ApiError('Invalid month: expected YYYY-MM', 400)
      windowStart = parsed
    } else {
      const now = new Date()
      windowStart = new Date(now.getFullYear(), now.getMonth(), 1)
    }
    // first-of-next-month (exclusive window end)
    const windowEnd = new Date(windowStart.getFullYear(), windowStart.getMonth() + 1, 1)
    const now = new Date()

    const users = await db.user.findMany({
      where: { hourlyRate: { not: null } },
      select: {
        id: true,
        name: true,
        role: true,
        hourlyRate: true,
        attendance: {
          where: {
            checkInAt: { lt: windowEnd },
            OR: [{ checkOutAt: null }, { checkOutAt: { gt: windowStart } }],
          },
          select: { checkInAt: true, checkOutAt: true, lateMinutes: true },
        },
      },
      orderBy: { name: 'asc' },
    })

    const lines: PayrollLine[] = []
    let totalHoursRaw = 0
    let totalGrossRaw = 0

    for (const user of users) {
      const rate = user.hourlyRate
      if (rate === null) continue // unreachable given the where-clause; type guard

      let hoursRaw = 0
      let lateMinutes = 0
      let sessions = 0
      for (const session of user.attendance) {
        // clip the session into the window; open sessions accrue only up to now
        const start = session.checkInAt > windowStart ? session.checkInAt : windowStart
        let end: Date
        if (session.checkOutAt === null) {
          end = windowEnd < now ? windowEnd : now // cap open shifts at `now`
        } else {
          end = session.checkOutAt
        }
        const ms = end.getTime() - start.getTime()
        if (ms > 0) {
          hoursRaw += ms / MS_PER_HOUR
          sessions += 1
        }
        // lateness counts for shifts that START inside the window
        if (session.checkInAt >= windowStart && session.checkInAt < windowEnd) {
          lateMinutes += session.lateMinutes
        }
      }
      if (sessions === 0) continue // no contributing session in this window

      const hours = round2(Math.max(0, hoursRaw))
      const grossPay = round2(hours * rate)
      totalHoursRaw += hours
      totalGrossRaw += grossPay
      lines.push({
        userId: user.id,
        name: user.name,
        role: user.role,
        hourlyRate: rate,
        sessions,
        hours,
        grossPay,
        lateMinutes,
      })
    }

    lines.sort((a, b) => b.grossPay - a.grossPay)

    const report: PayrollReport = {
      // inclusive display range: first day → last day of the month
      from: formatLocalDate(windowStart),
      to: formatLocalDate(new Date(windowStart.getFullYear(), windowStart.getMonth() + 1, 0)),
      lines,
      totalHours: round2(totalHoursRaw),
      totalGrossPay: round2(totalGrossRaw),
    }

    return NextResponse.json(report)
  } catch (err) {
    return errorResponse(err)
  }
}
