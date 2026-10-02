import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { errorResponse, requireAuth } from '@/lib/auth'
import type { AttendanceRecord } from '@/lib/types'

// R11: session-based "my attendance today" for the navbar shift clock.
// Any authenticated user can read their own state (no permission gate —
// checking in/out is universal, like the login screen's public card).

type ShiftRow = { id: number; name: string; startTime: string; endTime: string }

type AttendanceRow = {
  id: number
  userId: number
  checkInAt: Date
  checkOutAt: Date | null
  lateMinutes: number
  user: {
    id: number
    name: string
    role: string
    roleId: number | null
    roleRecord: { name: string } | null
  }
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
 * (Same matching as the attendance list route.)
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

/** AttendanceRecord serializer (same field shapes as the other attendance routes). */
function serializeAttendance(row: AttendanceRow, shiftName: string | null): AttendanceRecord {
  const roleName = row.user.roleId ? (row.user.roleRecord?.name ?? null) : null
  return {
    id: row.id,
    userId: row.userId,
    user: { id: row.user.id, name: row.user.name, role: row.user.role, roleName },
    checkInAt: row.checkInAt.toISOString(),
    checkOutAt: row.checkOutAt ? row.checkOutAt.toISOString() : null,
    lateMinutes: row.lateMinutes,
    workedMinutes: row.checkOutAt
      ? Math.max(0, Math.round((row.checkOutAt.getTime() - row.checkInAt.getTime()) / 60000))
      : null,
    shiftName,
  }
}

const ATTENDANCE_SELECT = {
  id: true,
  userId: true,
  checkInAt: true,
  checkOutAt: true,
  lateMinutes: true,
  user: {
    select: {
      id: true,
      name: true,
      role: true,
      roleId: true,
      roleRecord: { select: { name: true } },
    },
  },
} as const

export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth(req)

    const now = new Date()
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const dayEnd = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() + 1)

    // The open record (any date — an overnight shift stays open past midnight)
    // and the latest record checked in today, resolved in parallel.
    const [open, todayRow, activeShifts] = await Promise.all([
      db.attendance.findFirst({
        where: { userId: session.userId, checkOutAt: null },
        orderBy: { checkInAt: 'desc' },
        select: ATTENDANCE_SELECT,
      }),
      db.attendance.findFirst({
        where: { userId: session.userId, checkInAt: { gte: dayStart, lt: dayEnd } },
        orderBy: { checkInAt: 'desc' },
        select: ATTENDANCE_SELECT,
      }),
      db.shift.findMany({ where: { active: true }, orderBy: { id: 'asc' } }),
    ])

    // While a record is open it is the live state (an open record from an
    // earlier night is still the shift in progress); otherwise fall back to
    // today's latest (closed) record.
    const current = open ?? todayRow
    const today: AttendanceRecord | null = current
      ? serializeAttendance(
          current,
          matchShift(minutesOfDay(current.checkInAt), activeShifts)?.name ?? null,
        )
      : null

    const onShift = open !== null
    const workedMinutes = open
      ? Math.max(0, Math.round((now.getTime() - open.checkInAt.getTime()) / 60000))
      : null

    return NextResponse.json({ today, onShift, workedMinutes })
  } catch (err) {
    return errorResponse(err)
  }
}
