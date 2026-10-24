// /api/deductions — r65: salary deductions control center.
//
// GET ?month=YYYY-MM — the deductions report for one payroll month:
//   · the lateness rules in force
//   · per-staff lines: attendance (days/hours/sessions), late minutes +
//     occurrences, the COMPUTED lateness deduction (from the rules), the
//     manual SalaryDeduction rows for the month, and the total
// POST { userId, amount, reason, month? } — record a manual deduction
//   (audited; rides the hybrid outbox so every plane converges).
//
// Gate: the manager (admin/developer/super admin) OR any custom role
// holding the 'deductions' permission (assignable via the Roles editor).

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, errorResponse, ApiError } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { emitOutboxEvent } from '@/lib/hybrid-sync/outbox'
import { round2 } from '@/lib/orders'
import { LATENESS_RULES_KEY, parseLatenessRules } from '@/lib/constants'
import type { DeductionsReport, DeductionsUserLine, SalaryDeductionRow } from '@/lib/types'

const MONTH_RE = /^(\d{4})-(\d{2})$/
const MS_PER_HOUR = 3_600_000
const REASON_MAX = 200
const AMOUNT_MAX = 1_000_000

function parseLocalMonth(s: string | null): Date | null {
  if (s === null || s === '') return null
  const m = MONTH_RE.exec(s)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  if (mo < 1 || mo > 12) return null
  const dt = new Date(y, mo - 1, 1)
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1) return null
  return dt
}

function formatLocalDate(d: Date): string {
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${mo}-${dd}`
}

function computeLatenessDeduction(
  rules: { enabled: boolean; perMinuteEgp: number; perOccurrenceEgp: number; capEgp: number },
  lateMinutes: number,
  lateCount: number,
): number {
  if (!rules.enabled) return 0
  const raw = round2(lateMinutes * rules.perMinuteEgp + lateCount * rules.perOccurrenceEgp)
  const capped = rules.capEgp > 0 ? Math.min(raw, rules.capEgp) : raw
  return round2(Math.max(0, capped))
}

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['admin', 'deductions'])

    const sp = new URL(req.url).searchParams
    const monthParam = sp.get('month')
    const now = new Date()
    const fallback = new Date(now.getFullYear(), now.getMonth(), 1)
    const windowStart = parseLocalMonth(monthParam) ?? fallback
    const windowEnd = new Date(windowStart.getFullYear(), windowStart.getMonth() + 1, 1)
    const periodMonth = `${windowStart.getFullYear()}-${String(windowStart.getMonth() + 1).padStart(2, '0')}`

    const rulesRow = await db.appSetting.findUnique({ where: { key: LATENESS_RULES_KEY } })
    const rules = parseLatenessRules(rulesRow?.value)

    // every ACTIVE staff member (minus the exempt developer — he is not
    // subject to attendance deductions; the manager super admin row is
    // excluded below via isSuperAdmin: false)
    const users = await db.user.findMany({
      where: { active: true, role: { not: 'developer' }, isSuperAdmin: false },
      select: {
        id: true,
        name: true,
        role: true,
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

    const deductionRows = await db.salaryDeduction.findMany({
      where: { periodMonth },
      select: {
        id: true,
        userId: true,
        amount: true,
        reason: true,
        createdAt: true,
        user: { select: { name: true } },
        createdBy: { select: { name: true } },
      },
      orderBy: { id: 'asc' },
    })
    const manualByUser = new Map<number, SalaryDeductionRow[]>()
    for (const row of deductionRows) {
      const serialized: SalaryDeductionRow = {
        id: row.id,
        userId: row.userId,
        userName: row.user?.name ?? `#${row.userId}`,
        periodMonth,
        amount: row.amount,
        reason: row.reason,
        createdByName: row.createdBy?.name ?? null,
        createdAt: row.createdAt.toISOString(),
      }
      const list = manualByUser.get(row.userId) ?? []
      list.push(serialized)
      manualByUser.set(row.userId, list)
    }

    const lines: DeductionsUserLine[] = []
    let totalManual = 0
    let totalLateness = 0

    for (const user of users) {
      let hoursRaw = 0
      let lateMinutes = 0
      let lateCount = 0
      let sessions = 0
      const daysSet = new Set<string>()
      for (const session of user.attendance) {
        const start = session.checkInAt > windowStart ? session.checkInAt : windowStart
        let end: Date
        if (session.checkOutAt === null) {
          end = windowEnd < now ? windowEnd : now
        } else {
          end = session.checkOutAt
        }
        const ms = end.getTime() - start.getTime()
        if (ms > 0) {
          hoursRaw += ms / MS_PER_HOUR
          sessions += 1
        }
        if (session.checkInAt >= windowStart && session.checkInAt < windowEnd) {
          daysSet.add(formatLocalDate(session.checkInAt))
          lateMinutes += session.lateMinutes
          if (session.lateMinutes > 0) lateCount += 1
        }
      }
      const manual = manualByUser.get(user.id) ?? []
      // include staff with ANY activity this month (attendance or deductions)
      if (sessions === 0 && daysSet.size === 0 && manual.length === 0) continue

      const manualDeductionTotal = round2(Math.max(0, manual.reduce((s, d) => s + d.amount, 0)))
      const latenessDeduction = computeLatenessDeduction(rules, lateMinutes, lateCount)
      totalManual += manualDeductionTotal
      totalLateness += latenessDeduction
      lines.push({
        userId: user.id,
        name: user.name,
        role: user.role,
        days: daysSet.size,
        hours: round2(Math.max(0, hoursRaw)),
        sessions,
        lateMinutes,
        lateCount,
        latenessDeduction,
        manualDeductions: manual,
        manualDeductionTotal,
        totalDeductions: round2(latenessDeduction + manualDeductionTotal),
      })
    }

    const report: DeductionsReport = {
      month: periodMonth,
      from: formatLocalDate(windowStart),
      to: formatLocalDate(new Date(windowStart.getFullYear(), windowStart.getMonth() + 1, 0)),
      rules,
      lines,
      totalManual: round2(totalManual),
      totalLateness: round2(totalLateness),
      totalDeductions: round2(totalManual + totalLateness),
    }

    return NextResponse.json(report)
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth(req, ['admin', 'deductions'])

    const body = (await req.json().catch(() => null)) as {
      userId?: unknown
      amount?: unknown
      reason?: unknown
      month?: unknown
    } | null

    const userId = Number(body?.userId)
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new ApiError('A valid userId is required', 400)
    }
    const amount = Number(body?.amount)
    if (!Number.isFinite(amount) || amount <= 0 || amount > AMOUNT_MAX) {
      throw new ApiError('Amount must be a positive number', 400)
    }
    const reason = String(body?.reason ?? '').trim()
    if (reason.length < 2) {
      throw new ApiError('A reason of at least 2 characters is required (audit trail)', 400)
    }
    if (reason.length > REASON_MAX) {
      throw new ApiError(`Reason too long (max ${REASON_MAX} chars)`, 400)
    }
    // month defaults to the current payroll month
    const monthParam = typeof body?.month === 'string' ? body.month : null
    const parsed = parseLocalMonth(monthParam)
    if (monthParam !== null && !parsed) {
      throw new ApiError('Invalid month: expected YYYY-MM', 400)
    }
    const now = new Date()
    const windowStart = parsed ?? new Date(now.getFullYear(), now.getMonth(), 1)
    const periodMonth = `${windowStart.getFullYear()}-${String(windowStart.getMonth() + 1).padStart(2, '0')}`

    const target = await db.user.findFirst({
      where: { id: userId, active: true },
      select: { id: true, name: true, email: true },
    })
    if (!target) throw new ApiError('User not found', 404)

    // R30 hybrid sync: the deduction + its outbox event commit together —
    // the row converges to every plane (desktop, cloud, replicas).
    const created = await db.$transaction(async (tx) => {
      const saved = await tx.salaryDeduction.create({
        data: {
          userId,
          periodMonth,
          amount: round2(amount),
          reason,
          createdById: session.userId,
        },
      })
      await emitOutboxEvent(tx, {
        entity: 'SalaryDeduction',
        entityId: saved.id,
        operation: 'create',
        row: saved,
      })
      return saved
    })

    await logAudit({
      user: session,
      action: 'deduction.create',
      entity: 'payroll',
      entityId: created.id,
      details: `Deduction EGP ${round2(amount).toFixed(2)} for ${target.name} (${target.email}) — ${periodMonth} — ${reason}`,
    })

    return NextResponse.json(
      {
        deduction: {
          id: created.id,
          userId,
          userName: target.name,
          periodMonth,
          amount: created.amount,
          reason: created.reason,
          createdByName: session.name,
          createdAt: created.createdAt.toISOString(),
        },
      },
      { status: 201 },
    )
  } catch (err) {
    return errorResponse(err)
  }
}
