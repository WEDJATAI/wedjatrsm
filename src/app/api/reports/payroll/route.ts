// /api/reports/payroll — Payroll (Odoo HR lite): attendance-connected salary
// for one calendar month. GET ?month=YYYY-MM (default: current month in the
// SERVER's local timezone).
//
// r65 upgrade — salaries are now connected to attendance TIME and DAYS:
//   · base pay = monthlySalary (salaried staff, takes precedence) OR
//     hours × hourlyRate (hourly staff, unchanged)
//   · days = distinct calendar days with a check-in in the window
//   · lateness deduction = COMPUTED live from the manager-configured
//     lateness rules (AppSetting 'latenessRules') + Attendance.lateMinutes
//     (never stored — rule edits reflect immediately)
//   · manual deductions = SalaryDeduction rows for the month
//   · net pay = base − (lateness + manual), never below 0
//
// Window: local first-of-month → first-of-next-month (exclusive end).
// A session contributes when it OVERLAPS the window (checkIn < windowEnd and
// (still open OR checkOut > windowStart)); its hours are clipped to the
// window, and an OPEN session only accrues up to `now`.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, errorResponse, ApiError } from '@/lib/auth'
import { round2 } from '@/lib/orders'
import { LATENESS_RULES_KEY, parseLatenessRules } from '@/lib/constants'
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

/** r65: the lateness deduction for one staff member in the window —
 * computed from the rules (never stored). cap 0 = uncapped. */
export function computeLatenessDeduction(
  rules: { enabled: boolean; perMinuteEgp: number; perOccurrenceEgp: number; capEgp: number },
  lateMinutes: number,
  lateCount: number,
): number {
  if (!rules.enabled) return 0
  const raw =
    round2(lateMinutes * rules.perMinuteEgp + lateCount * rules.perOccurrenceEgp)
  const capped = rules.capEgp > 0 ? Math.min(raw, rules.capEgp) : raw
  return round2(Math.max(0, capped))
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
    const periodMonth = `${windowStart.getFullYear()}-${String(windowStart.getMonth() + 1).padStart(2, '0')}`

    // r65: the manager-configured lateness rules drive the computed deduction
    const rulesRow = await db.appSetting.findUnique({ where: { key: LATENESS_RULES_KEY } })
    const rules = parseLatenessRules(rulesRow?.value)

    const users = await db.user.findMany({
      where: { OR: [{ hourlyRate: { not: null } }, { monthlySalary: { not: null } }] },
      select: {
        id: true,
        name: true,
        role: true,
        hourlyRate: true,
        monthlySalary: true,
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

    // r65: manual deductions for the month (grouped per user in one pass)
    const deductionRows = await db.salaryDeduction.findMany({
      where: { periodMonth },
      select: {
        id: true,
        userId: true,
        amount: true,
        reason: true,
        createdAt: true,
        createdBy: { select: { name: true } },
      },
      orderBy: { id: 'asc' },
    })
    const manualByUser = new Map<number, number>()
    for (const row of deductionRows) {
      manualByUser.set(row.userId, round2((manualByUser.get(row.userId) ?? 0) + row.amount))
    }

    const lines: PayrollLine[] = []
    let totalHoursRaw = 0
    let totalGrossRaw = 0
    let totalDeductionsRaw = 0
    let totalNetRaw = 0

    for (const user of users) {
      const rate = user.hourlyRate
      const salary = user.monthlySalary
      if (rate === null && salary === null) continue // unreachable; type guard

      let hoursRaw = 0
      let lateMinutes = 0
      let lateCount = 0
      let sessions = 0
      const daysSet = new Set<string>()
      for (const session of user.attendance) {
        // clip the session into the window; open sessions accrue only to now
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
        // lateness + days count for shifts that START inside the window
        if (session.checkInAt >= windowStart && session.checkInAt < windowEnd) {
          daysSet.add(formatLocalDate(session.checkInAt))
          lateMinutes += session.lateMinutes
          if (session.lateMinutes > 0) lateCount += 1
        }
      }
      if (sessions === 0 && daysSet.size === 0) continue // no contribution

      const hours = round2(Math.max(0, hoursRaw))
      const days = daysSet.size
      // r65: salaried staff — the monthly base (attendance stats shown
      // alongside); hourly staff — hours × rate (unchanged R17 math)
      const basePay = round2(salary != null ? salary : (rate ?? 0) * hours)
      const latenessDeduction = computeLatenessDeduction(rules, lateMinutes, lateCount)
      const manualDeductionTotal = round2(Math.max(0, manualByUser.get(user.id) ?? 0))
      const totalDeductions = round2(latenessDeduction + manualDeductionTotal)
      const netPay = round2(Math.max(0, basePay - totalDeductions))

      totalHoursRaw += hours
      totalGrossRaw += basePay
      totalDeductionsRaw += totalDeductions
      totalNetRaw += netPay
      lines.push({
        userId: user.id,
        name: user.name,
        role: user.role,
        hourlyRate: rate ?? 0,
        monthlySalary: salary,
        sessions,
        days,
        hours,
        basePay,
        grossPay: basePay,
        lateMinutes,
        lateCount,
        latenessDeduction,
        manualDeductionTotal,
        totalDeductions,
        netPay,
      })
    }

    lines.sort((a, b) => b.netPay - a.netPay)

    const report: PayrollReport = {
      // inclusive display range: first day → last day of the month
      from: formatLocalDate(windowStart),
      to: formatLocalDate(new Date(windowStart.getFullYear(), windowStart.getMonth() + 1, 0)),
      lines,
      totalHours: round2(totalHoursRaw),
      totalGrossPay: round2(totalGrossRaw),
      totalDeductions: round2(totalDeductionsRaw),
      totalNetPay: round2(totalNetRaw),
      latenessRules: rules,
    }

    return NextResponse.json(report)
  } catch (err) {
    return errorResponse(err)
  }
}
