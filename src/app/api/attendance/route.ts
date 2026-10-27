import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import type { AttendanceRecord } from '@/lib/types'

// Daily attendance log. The day window is LOCAL midnight → next midnight
// (same parsing pattern as /api/reports/sales).

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const MAX_LOOKBACK_DAYS = 31

type ShiftRow = { id: number; name: string; startTime: string; endTime: string }

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

function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes()
}

function parseHHMM(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/**
 * Find the shift whose attendance window contains the given minute-of-day.
 * Day shift window: [start, start+8h]; overnight shift (end < start): start → end+24h
 * (a post-midnight check-in matches while its time-of-day ≤ endTime).
 * When several windows match, prefer the latest-starting shift.
 */
function matchShift(minuteOfDay: number, shifts: ShiftRow[]): ShiftRow | null {
  let best: ShiftRow | null = null
  let bestStart = -1
  for (const shift of shifts) {
    const start = parseHHMM(shift.startTime)
    const end = parseHHMM(shift.endTime)
    if (start === null || end === null) continue
    const windowEnd = end < start ? end + 1440 : start + 480
    const inWindow =
      minuteOfDay >= start
        ? minuteOfDay <= windowEnd
        : minuteOfDay <= windowEnd - 1440
    if (!inWindow) continue
    if (start > bestStart) {
      best = shift
      bestStart = start
    }
  }
  return best
}

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['admin', 'attendance'])

    const sp = new URL(req.url).searchParams
    const dateRaw = sp.get('date')
    const now = new Date()
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())

    let day: Date
    if (dateRaw !== null && dateRaw !== '') {
      const parsed = parseLocalDate(dateRaw)
      if (!parsed) throw new ApiError('Invalid date: expected YYYY-MM-DD', 400)
      day = parsed
    } else {
      day = todayStart
    }

    if (day.getTime() > todayStart.getTime()) {
      throw new ApiError('Date cannot be in the future', 400)
    }
    if (day.getTime() < todayStart.getTime() - MAX_LOOKBACK_DAYS * 86400000) {
      throw new ApiError(`Date must be within the past ${MAX_LOOKBACK_DAYS} days`, 400)
    }

    const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate())
    const dayEnd = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() + 1)

    const [rows, shifts] = await Promise.all([
      db.attendance.findMany({
        where: { checkInAt: { gte: dayStart, lt: dayEnd } },
        orderBy: { checkInAt: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              role: true,
              roleId: true,
              roleRecord: { select: { name: true } },
            },
          },
        },
      }),
      db.shift.findMany({ where: { active: true }, orderBy: { id: 'asc' } }),
    ])

    const records: AttendanceRecord[] = rows.map((row) => {
      const roleName = row.user.roleId ? (row.user.roleRecord?.name ?? null) : null
      const shift = matchShift(minutesOfDay(row.checkInAt), shifts)
      return {
        id: row.id,
        userId: row.userId,
        user: {
          id: row.user.id,
          name: row.user.name,
          role: row.user.role,
          roleName,
        },
        checkInAt: row.checkInAt.toISOString(),
        checkOutAt: row.checkOutAt ? row.checkOutAt.toISOString() : null,
        lateMinutes: row.lateMinutes,
        workedMinutes: row.checkOutAt
          ? Math.max(0, Math.round((row.checkOutAt.getTime() - row.checkInAt.getTime()) / 60000))
          : null,
        shiftName: shift?.name ?? null,
      }
    })

    const summary = {
      total: records.length,
      checkedIn: new Set(rows.map((row) => row.userId)).size,
      stillIn: records.filter((r) => r.checkOutAt === null).length,
      lateCount: records.filter((r) => r.lateMinutes > 0).length,
      totalWorkedMinutes: records.reduce((sum, r) => sum + (r.workedMinutes ?? 0), 0),
    }

    return NextResponse.json({ records, summary })
  } catch (err) {
    return errorResponse(err)
  }
}
