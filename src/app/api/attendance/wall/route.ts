import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse } from '@/lib/auth'
import { checkRateLimit, clientIp, resetRateLimit } from '@/lib/rate-limit'
import { LATE_GRACE_MINUTES } from '@/lib/constants'
import { emitOutboxEvent } from '@/lib/hybrid-sync/outbox'
import { logAudit } from '@/lib/audit'
import {
  computeLateMinutes,
  formatHHMM,
  matchShift,
  minutesOfDay,
  readJsonBody,
  resolveRoleLabel,
} from '@/lib/attendance'

// ─── R24 Team Wall — PIN-verified status / clock-in / clock-out ──────
// POST /api/attendance/wall   body: { userId, pin, action? }
//   action omitted → status: current on-shift state + matched shift info
//   action 'in'    → clock in  (same rules as /api/attendance/check-in)
//   action 'out'   → clock out (same rules as /api/attendance/check-out)
// PUBLIC (no session) like the check-in/out endpoints — the wall is a
// kiosk. Brute-force guarded: 10 attempts / 5 min per ip+userId.

type ShiftInfo = { id: number; name: string; startTime: string; endTime: string }

export async function POST(req: NextRequest) {
  try {
    const body = await readJsonBody(req)

    // Brute-force guard, counted before processing (same policy as check-in/out).
    const rlKey = `attwall:${clientIp(req)}:${String(body.userId).slice(0, 12)}`
    const rl = checkRateLimit(rlKey, 10, 5 * 60 * 1000)
    if (!rl.ok) {
      throw new ApiError(`Too many attempts — try again in ${rl.retryAfterSec}s`, 429)
    }

    const userId = Number(body.userId)
    const pin =
      body.pin === null || body.pin === undefined ? '' : String(body.pin).trim()
    const action = body.action === 'in' || body.action === 'out' ? body.action : null

    if (!Number.isInteger(userId) || userId <= 0 || pin === '') {
      throw new ApiError('User and PIN are required', 400)
    }

    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        role: true,
        roleId: true,
        pin: true,
        active: true,
        roleRecord: { select: { name: true, permissions: true, active: true } },
      },
    })
    if (!user || !user.active || user.pin === null || pin !== user.pin) {
      throw new ApiError('Invalid credentials', 401)
    }

    const { roleName, roleLabel } = resolveRoleLabel(user)
    const userPayload = {
      id: user.id,
      name: user.name,
      role: user.role,
      roleLabel,
      roleName,
    }

    const open = await db.attendance.findFirst({
      where: { userId: user.id, checkOutAt: null },
      orderBy: { checkInAt: 'desc' },
    })

    // ── status only (no mutation) ───────────────────────────────────
    if (!action) {
      const activeShifts = await db.shift.findMany({
        where: { active: true },
        orderBy: { id: 'asc' },
      })
      const shift = matchShift(minutesOfDay(new Date()), activeShifts)
      const shiftInfo: ShiftInfo | null = shift
        ? { id: shift.id, name: shift.name, startTime: shift.startTime, endTime: shift.endTime }
        : null
      resetRateLimit(rlKey)
      return NextResponse.json({
        ok: true,
        user: userPayload,
        onShift: open !== null,
        checkedInAt: open ? open.checkInAt.toISOString() : null,
        shift: shiftInfo,
      })
    }

    // ── clock IN ────────────────────────────────────────────────────
    if (action === 'in') {
      if (open) {
        throw new ApiError(`Already checked in at ${formatHHMM(open.checkInAt)}`, 400)
      }
      const now = new Date()
      const activeShifts = await db.shift.findMany({
        where: { active: true },
        orderBy: { id: 'asc' },
      })
      const shift = matchShift(minutesOfDay(now), activeShifts)
      const lateMinutes = computeLateMinutes(now, shift, LATE_GRACE_MINUTES)
      // R39 hybrid sync: kiosk clock-in + its outbox event commit together
      // (same contract as /api/attendance/check-in — PUBLIC route, device
      // identity comes from local device state).
      const record = await db.$transaction(async (tx) => {
        const saved = await tx.attendance.create({
          data: { userId: user.id, checkInAt: now, lateMinutes },
        })
        await emitOutboxEvent(tx, {
          entity: 'Attendance',
          entityId: saved.id,
          operation: 'create',
          row: saved,
        })
        return saved
      })
      resetRateLimit(rlKey)
      // R39: kiosk clock actions are payroll source data — audit them
      await logAudit({
        user: { userId: user.id, name: user.name, personId: null, personName: null },
        action: 'attendance.clockIn',
        entity: 'payroll',
        entityId: record.id,
        details: `${user.name} clocked in (wall)${lateMinutes > 0 ? ` (LATE ${lateMinutes} min)` : ''}${shift ? ` — ${shift.name}` : ''}`,
      })
      return NextResponse.json({
        ok: true,
        action: 'in',
        user: userPayload,
        checkInAt: record.checkInAt.toISOString(),
        late: lateMinutes > 0,
        lateMinutes,
        shift: shift
          ? { id: shift.id, name: shift.name, startTime: shift.startTime, endTime: shift.endTime }
          : null,
      })
    }

    // ── clock OUT ───────────────────────────────────────────────────
    if (!open) throw new ApiError('No open check-in found', 400)
    const now = new Date()
    // R39 hybrid sync: kiosk clock-out + its outbox event commit together
    // (same contract as /api/attendance/check-out).
    const updated = await db.$transaction(async (tx) => {
      const saved = await tx.attendance.update({
        where: { id: open.id },
        data: { checkOutAt: now },
      })
      await emitOutboxEvent(tx, {
        entity: 'Attendance',
        entityId: saved.id,
        operation: 'update',
        row: saved,
      })
      return saved
    })
    resetRateLimit(rlKey)
    // R39: kiosk clock actions are payroll source data — audit them
    await logAudit({
      user: { userId: user.id, name: user.name, personId: null, personName: null },
      action: 'attendance.clockOut',
      entity: 'payroll',
      entityId: updated.id,
      details: `${user.name} clocked out (wall) — ${Math.max(0, Math.round((now.getTime() - updated.checkInAt.getTime()) / 60000))} min worked`,
    })
    const workedMinutes = Math.max(
      0,
      Math.round((now.getTime() - updated.checkInAt.getTime()) / 60000),
    )
    return NextResponse.json({
      ok: true,
      action: 'out',
      user: userPayload,
      checkInAt: updated.checkInAt.toISOString(),
      checkOutAt: now.toISOString(),
      workedMinutes,
    })
  } catch (err) {
    return errorResponse(err)
  }
}
