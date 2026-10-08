import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { maybeAutoBackup } from '@/lib/backup'
import {
  createSessionToken,
  derivePermissions,
  ensureSuperAdmin,
  errorResponse,
  MANAGER_DEFAULT_PIN,
  setSessionCookie,
} from '@/lib/auth'
import { checkRateLimit, clientIp, peekRateLimit, resetRateLimit } from '@/lib/rate-limit'

/**
 * R27 — Manager sign-in: the ONE super admin's private door.
 *
 * The Team Wall's "Manager sign-in" corner is Dr Ihab's personal entry:
 * a welcome by name, then ONLY his PIN (first time: 123456 — he sets his
 * own right after). His PIN never works on the generic wall/PIN doors,
 * and no other account can pass through this one.
 */

export async function GET() {
  try {
    const manager = await ensureSuperAdmin()
    return NextResponse.json({
      name: manager.active ? manager.name : null,
      usingDefaultPin: manager.pin === MANAGER_DEFAULT_PIN,
    })
  } catch (err) {
    return errorResponse(err)
  }
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
      // missing/invalid JSON handled by the 400 below
    }
    const pin = body.pin == null ? '' : String(body.pin).trim()
    if (!/^\d{6}$/.test(pin)) {
      return NextResponse.json({ error: 'Enter your 6-digit PIN' }, { status: 400 })
    }

    // ── Hardening (same two-bucket scheme as the classic login) ──
    const ip = clientIp(req)
    const ipFailKey = `manager-login-ipfail:${ip}`
    const ipFail = peekRateLimit(ipFailKey, 10, 5 * 60 * 1000)
    if (!ipFail.ok) {
      return NextResponse.json(
        { error: `Too many failed attempts — try again in ${ipFail.retryAfterSec}s` },
        { status: 429 },
      )
    }
    const rlKey = `manager-login:${ip}`
    const rl = checkRateLimit(rlKey, 10, 5 * 60 * 1000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `Too many attempts — try again in ${rl.retryAfterSec}s` },
        { status: 429 },
      )
    }

    const manager = await ensureSuperAdmin()
    if (!manager.active) {
      return NextResponse.json(
        { error: 'Manager sign-in is disabled — contact support' },
        { status: 403 },
      )
    }

    if (manager.pin !== pin) {
      // record the failure against the per-IP budget (identifier bucket
      // already counted the attempt above)
      checkRateLimit(ipFailKey, 10, 5 * 60 * 1000)
      return NextResponse.json({ error: 'Wrong PIN — try again' }, { status: 401 })
    }

    const permissions = derivePermissions(manager.role, null) // admin → full grants
    const token = await createSessionToken({
      userId: manager.id,
      email: manager.email,
      name: manager.name,
      role: manager.role,
      permissions,
      roleName: null,
      personId: null,
      personName: null,
      isSuperAdmin: true,
    })
    resetRateLimit(rlKey)
    const res = NextResponse.json({
      user: {
        id: manager.id,
        email: manager.email,
        name: manager.name,
        role: manager.role,
        permissions,
        roleName: null,
        personId: null,
        personName: null,
        isSuperAdmin: true,
      },
      // first-time experience: still on 123456 → the app prompts him to
      // set his own PIN the moment he lands
      usingDefaultPin: manager.pin === MANAGER_DEFAULT_PIN,
      token,
    })
    setSessionCookie(res, token, req)
    void maybeAutoBackup()
    return res
  } catch (err) {
    return errorResponse(err)
  }
}
