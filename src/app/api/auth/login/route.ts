import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { maybeAutoBackup } from '@/lib/backup'
import {
  createSessionToken,
  derivePermissions,
  errorResponse,
  setSessionCookie,
  verifyPassword,
} from '@/lib/auth'
import { checkRateLimit, clientIp, peekRateLimit, resetRateLimit } from '@/lib/rate-limit'

// r65: attendance is a MUST before signing in — every staff member EXCEPT
// management (super admin / 'admin' role) and the developer must have an
// OPEN attendance session (clocked in, not yet clocked out) to sign in
// through the generic doors. The Manager and Developer corners are separate
// routes and unaffected. An open (not "today's") session is required so
// overnight shifts work naturally.
const ATTENDANCE_EXEMPT_ROLES = new Set(['admin', 'developer'])

type LoginUser = {
  id: number
  email: string
  name: string
  role: string
  roleId: number | null
  roleRecord: { name: string; permissions: string; active: boolean } | null
  passwordHash: string
  active: boolean
  isSuperAdmin: boolean
  people: { id: number; name: string }[]
}

export async function POST(req: NextRequest) {
  try {
    let body: Record<string, unknown> = {}
    try {
      const parsed: unknown = await req.json()
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>
      }
    } catch {
      // missing/invalid JSON body → handled by the 400 below
    }

    const rawPin: unknown = body.pin
    const pin =
      rawPin === null || rawPin === undefined ? '' : String(rawPin).trim()
    const email =
      typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    const password = typeof body.password === 'string' ? body.password : ''

    if (!pin && (!email || !password)) {
      return NextResponse.json(
        { error: 'Email and password or PIN required' },
        { status: 400 },
      )
    }

    // ── Hardening (R16): two independent buckets ──
    // 1) per IP + identifier (10 attempts / 5 min, reset on success) — the
    //    classic per-account brute-force guard.
    // 2) per-IP FAILURE budget (30 failures / 5 min) that does NOT key on the
    //    identifier: PIN quick-login sprays a different PIN on every request,
    //    which used to give each guess a fresh bucket. Now the IP itself is
    //    throttled after 30 failed logins of any kind (a full restaurant team
    //    logging in never hits this — only failures count).
    const ip = clientIp(req)
    const ipFailKey = `login-ipfail:${ip}`
    const ipFail = peekRateLimit(ipFailKey, 30, 5 * 60 * 1000)
    if (!ipFail.ok) {
      return NextResponse.json(
        { error: `Too many failed attempts from this network — try again in ${ipFail.retryAfterSec}s` },
        { status: 429 },
      )
    }
    const rlKey = `login:${ip}:${(pin || email).slice(0, 60)}`
    const rl = checkRateLimit(rlKey, 10, 5 * 60 * 1000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `Too many attempts — try again in ${rl.retryAfterSec}s` },
        { status: 429 },
      )
    }

    let user: LoginUser | null = null

    if (pin) {
      // PIN quick-login: exact match on an active user.
      // R27: the manager's PIN is NOT accepted here — the super admin
      // signs in exclusively through the Manager corner
      // (POST /api/auth/manager-login), never the generic doors.
      // p11-d: same isolation for the developer — his PIN works only on
      // the Developer corner (POST /api/auth/developer-login).
      user = await db.user.findFirst({
        where: { pin, active: true, isSuperAdmin: false, role: { not: 'developer' } },
        include: {
          roleRecord: { select: { name: true, permissions: true, active: true } },
          people: { where: { active: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } },
        },
      })
    } else {
      const found = await db.user.findFirst({
        where: { email },
        include: {
          roleRecord: { select: { name: true, permissions: true, active: true } },
          people: { where: { active: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } },
        },
      })
      if (
        found &&
        found.active &&
        (await verifyPassword(password, found.passwordHash))
      ) {
        user = found
      }
    }

    if (!user) {
      // record the failure against the per-IP budget (identifier bucket
      // already counted the attempt above)
      checkRateLimit(ipFailKey, 30, 5 * 60 * 1000)
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
    }

    // ── r65: attendance gate — no clock-in, no sign-in ──────────────
    // Non-management staff must be on the clock (an open attendance
    // session) before they can sign in. The PIN matched, so this is a
    // 403 policy refusal (NOT a credential failure — it does not count
    // against the brute-force budgets; the code lets the client show a
    // localized message + jump straight to the check-in tab).
    const attendanceExempt =
      user.isSuperAdmin === true || ATTENDANCE_EXEMPT_ROLES.has(user.role)
    if (!attendanceExempt) {
      const openAttendance = await db.attendance.findFirst({
        where: { userId: user.id, checkOutAt: null },
        orderBy: { checkInAt: 'desc' },
        select: { id: true },
      })
      if (!openAttendance) {
        return NextResponse.json(
          {
            error: 'Attendance required — check in before signing in',
            code: 'attendance_required',
          },
          { status: 403 },
        )
      }
    }

    const roleRecord = user.roleId ? user.roleRecord : null
    const permissions = derivePermissions(
      user.role,
      roleRecord?.active ? roleRecord.permissions : null,
    )
    const roleName = roleRecord?.name ?? null

    // R19 person attribution: when the account has exactly ONE active person
    // registered, they are embedded in the session right away (zero extra
    // taps — the account is theirs in practice). With several people the
    // client shows a one-tap picker right after login.
    const autoPerson = user.people.length === 1 ? user.people[0] : null

    const token = await createSessionToken({
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      permissions,
      roleName,
      personId: autoPerson?.id ?? null,
      personName: autoPerson?.name ?? null,
    })
    resetRateLimit(rlKey)
    const res = NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        permissions,
        roleName,
        personId: autoPerson?.id ?? null,
        personName: autoPerson?.name ?? null,
      },
      // R19: active people under this account — when more than one, the
      // client asks who is operating the device before entering the app.
      people: user.people,
      // Raw token for the client-side Bearer fallback (used when cookies are
      // unavailable, e.g. cross-site preview iframes). Kept in localStorage.
      token,
    })
    setSessionCookie(res, token, req)
    // R14: daily automatic backup — fire-and-forget after successful login
    // (a POS always has at least one login per day). Never blocks the login.
    void maybeAutoBackup()
    return res
  } catch (err) {
    return errorResponse(err)
  }
}
