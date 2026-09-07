import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse } from '@/lib/auth'
import { checkRateLimit, clientIp, resetRateLimit } from '@/lib/rate-limit'
import { ROLE_LABELS } from '@/lib/constants'
import type { AttendanceRecord } from '@/lib/types'

// PUBLIC employee check-out (no session) — closes the latest open attendance
// record for the matched user. Same rate limiting as check-in.

type ShiftRow = { id: number; name: string; startTime: string; endTime: string }

type CheckInUser = {
  id: number
  email: string
  name: string
  role: string
  roleId: number | null
  pin: string | null
  active: boolean
  roleRecord: { name: string; permissions: string; active: boolean } | null
}

async function readBody(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await req.json()
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // fall through — invalid/empty JSON is treated as an empty body
  }
  return {}
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

/**
 * Match a username against users by email (ci, trimmed) or exact name (ci, trimmed).
 * Returns 'ambiguous' when several distinct users share the name.
 */
async function findUserByUsername(
  usernameRaw: unknown,
): Promise<CheckInUser | 'ambiguous' | null> {
  const username = String(usernameRaw ?? '').trim()
  if (!username) return null
  const lower = username.toLowerCase()
  const users = await db.user.findMany({
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      roleId: true,
      pin: true,
      active: true,
      roleRecord: { select: { name: true, permissions: true, active: true } },
    },
  })
  const byEmail = users.find((u) => u.email === lower)
  if (byEmail) return byEmail
  const byName = users.filter((u) => u.name.trim().toLowerCase() === lower)
  if (byName.length > 1) return 'ambiguous'
  return byName[0] ?? null
}

export async function POST(req: NextRequest) {
  try {
    const body = await readBody(req)

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

    const roleName = user.roleId ? (user.roleRecord?.name ?? null) : null
    const roleLabel =
      user.role === 'custom'
        ? (roleName ?? ROLE_LABELS.custom)
        : (ROLE_LABELS[user.role] ?? user.role)

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
