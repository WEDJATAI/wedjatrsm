import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse } from '@/lib/auth'
import { checkRateLimit, clientIp, resetRateLimit } from '@/lib/rate-limit'
import type { AttendanceRecord } from '@/lib/types'
import {
  findUserByUsername,
  matchShift,
  minutesOfDay,
  readJsonBody,
  resolveRoleLabel,
} from '@/lib/attendance'

// PUBLIC employee check-out (no session) — closes the latest open attendance
// record for the matched user. Same rate limiting as check-in.
// R24: pure helpers moved to @/lib/attendance (shared with the Team Wall).

export async function POST(req: NextRequest) {
  try {
    const body = await readJsonBody(req)

    // Brute-force guard: 10 attempts / 5 min per ip+username, counted before processing.
    const rlKey = `att:${clientIp(req)}:${String(body.username).slice(0, 60)}`
    const rl = checkRateLimit(rlKey, 10, 5 * 60 * 1000)
    if (!rl.ok) {
      throw new ApiError(`Too many attempts — try again in ${rl.retryAfterSec}s`, 429)
    }

    const username = body.username
    const pinRaw = body.pin
    const pin = pinRaw === null || pinRaw === undefined ? '' : String(pinRaw).trim()
    if (
      username === null ||
      username === undefined ||
      String(username).trim() === '' ||
      pin === ''
    ) {
      throw new ApiError('Username and PIN are required', 400)
    }

    const match = await findUserByUsername(username)
    if (match === 'ambiguous') {
      throw new ApiError('Multiple users match this name — use your email', 400)
    }
    if (!match) throw new ApiError('Invalid credentials', 401)
    if (!match.active) throw new ApiError('Invalid credentials', 401)
    if (match.pin === null) throw new ApiError('No PIN set for this user', 401)
    if (pin !== match.pin) throw new ApiError('Invalid credentials', 401)
    const user = match

    const open = await db.attendance.findFirst({
      where: { userId: user.id, checkOutAt: null },
      orderBy: { checkInAt: 'desc' },
    })
    if (!open) throw new ApiError('No open check-in found', 400)

    const now = new Date()
    const updated = await db.attendance.update({
      where: { id: open.id },
      data: { checkOutAt: now },
    })

    resetRateLimit(rlKey)

    const workedMinutes = Math.max(
      0,
      Math.round((now.getTime() - open.checkInAt.getTime()) / 60000),
    )
    const activeShifts = await db.shift.findMany({
      where: { active: true },
      orderBy: { id: 'asc' },
    })
    const shift = matchShift(minutesOfDay(open.checkInAt), activeShifts)

    const { roleName, roleLabel } = resolveRoleLabel(user)

    const attendance: AttendanceRecord = {
      id: updated.id,
      userId: updated.userId,
      user: { id: user.id, name: user.name, role: user.role, roleName },
      checkInAt: updated.checkInAt.toISOString(),
      checkOutAt: now.toISOString(),
      lateMinutes: updated.lateMinutes,
      workedMinutes,
      shiftName: shift?.name ?? null,
    }

    return NextResponse.json({
      user: { id: user.id, name: user.name, role: user.role, roleLabel, roleName },
      attendance,
      workedMinutes,
      shift: shift
        ? { id: shift.id, name: shift.name, startTime: shift.startTime, endTime: shift.endTime }
        : null,
    })
  } catch (err) {
    return errorResponse(err)
  }
}
