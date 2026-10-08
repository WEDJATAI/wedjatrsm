// ─── Shared attendance domain helpers ────────────────────────────────
// R24: extracted verbatim from api/attendance/check-in + check-out so the
// new wall endpoints reuse the exact, battle-tested logic (shift window
// matching, late minutes, username resolution). Pure functions + one db
// lookup — no behavior changes vs the original inline copies.

import { db } from '@/lib/db'
import { ROLE_LABELS } from '@/lib/constants'
import type { NextRequest } from 'next/server'

export type ShiftRow = { id: number; name: string; startTime: string; endTime: string }

export type AttendanceUserRow = {
  id: number
  email: string
  name: string
  role: string
  roleId: number | null
  pin: string | null
  active: boolean
  roleRecord: { name: string; permissions: string; active: boolean } | null
}

/** Tolerant JSON body reader (invalid/empty JSON → empty object). */
export async function readJsonBody(req: NextRequest): Promise<Record<string, unknown>> {
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

export function formatHHMM(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes()
}

export function parseHHMM(s: string): number | null {
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
export function matchShift(minuteOfDay: number, shifts: ShiftRow[]): ShiftRow | null {
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

/** Late minutes vs the matched shift: minutes after shift start minus the grace. */
export function computeLateMinutes(
  checkIn: Date,
  shift: ShiftRow | null,
  graceMinutes: number,
): number {
  if (!shift) return 0
  const start = parseHHMM(shift.startTime)
  if (start === null) return 0
  let diff = minutesOfDay(checkIn) - start
  if (diff < 0) diff += 1440 // overnight shift, checked in after midnight
  if (diff <= 0) return 0
  return Math.max(0, diff - graceMinutes)
}

/**
 * Match a username against users by email (ci, trimmed) or exact name (ci, trimmed).
 * Returns 'ambiguous' when several distinct users share the name.
 */
export async function findUserByUsername(
  usernameRaw: unknown,
): Promise<AttendanceUserRow | 'ambiguous' | null> {
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

/** Resolve the display label for a user's role (custom roles use their record name). */
export function resolveRoleLabel(user: {
  role: string
  roleId: number | null
  roleRecord: { name: string; permissions: string; active: boolean } | null
}): { roleName: string | null; roleLabel: string } {
  const roleName = user.roleId ? (user.roleRecord?.name ?? null) : null
  const roleLabel =
    user.role === 'custom'
      ? (roleName ?? ROLE_LABELS.custom)
      : (ROLE_LABELS[user.role] ?? user.role)
  return { roleName, roleLabel }
}
