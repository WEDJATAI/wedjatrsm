import { NextRequest, NextResponse } from 'next/server'
import { maybeAutoBackup } from '@/lib/backup'
import {
  createSessionToken,
  derivePermissions,
  DEVELOPER_DEFAULT_PIN,
  ensureDeveloper,
  errorResponse,
  setSessionCookie,
} from '@/lib/auth'
import { checkRateLimit, clientIp, peekRateLimit, resetRateLimit } from '@/lib/rate-limit'

/**
 * p11-d — Developer sign-in: the developer's private door (mirrors the
 * R27 manager corner).
 *
 * The Team Wall's "Developer" corner is the developer's personal entry:
 * a welcome by name, then ONLY his 6-digit PIN (first time: 111111 — he
 * sets his own right after). His PIN never works on the generic wall/PIN
 * doors, and no other account can pass through this one. The developer
 * role is admin-equivalent inside the app but is NOT a super admin
 * (isSuperAdmin stays false — only the manager holds that flag).
 */

export async function GET() {
  try {
    const developer = await ensureDeveloper()
    return NextResponse.json({
      name: developer.active ? developer.name : null,
      usingDefaultPin: developer.pin === DEVELOPER_DEFAULT_PIN,
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

    // ── Hardening (same two-bucket scheme as the manager door) ──
    const ip = clientIp(req)
    const ipFailKey = `developer-login-ipfail:${ip}`
    const ipFail = peekRateLimit(ipFailKey, 10, 5 * 60 * 1000)
    if (!ipFail.ok) {
      return NextResponse.json(
        { error: `Too many failed attempts — try again in ${ipFail.retryAfterSec}s` },
        { status: 429 },
      )
    }
    const rlKey = `developer-login:${ip}`
    const rl = checkRateLimit(rlKey, 10, 5 * 60 * 1000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `Too many attempts — try again in ${rl.retryAfterSec}s` },
        { status: 429 },
      )
    }

    const developer = await ensureDeveloper()
    if (!developer.active) {
      return NextResponse.json(
        { error: 'Developer sign-in is disabled — contact support' },
        { status: 403 },
      )
    }

    if (developer.pin !== pin) {
      // record the failure against the per-IP budget (identifier bucket
      // already counted the attempt above)
      checkRateLimit(ipFailKey, 10, 5 * 60 * 1000)
      return NextResponse.json({ error: 'Wrong PIN — try again' }, { status: 401 })
    }

    const permissions = derivePermissions(developer.role, null) // developer → full grants
    const token = await createSessionToken({
      userId: developer.id,
      email: developer.email,
      name: developer.name,
      role: developer.role,
      permissions,
      roleName: null,
      personId: null,
      personName: null,
      // p11-d: the developer is NOT a super admin — only the manager (R27) is
      isSuperAdmin: false,
    })
    resetRateLimit(rlKey)
    const res = NextResponse.json({
      user: {
        id: developer.id,
        email: developer.email,
        name: developer.name,
        role: developer.role,
        permissions,
        roleName: null,
        personId: null,
        personName: null,
        isSuperAdmin: false,
      },
      // first-time experience: still on 111111 → the app prompts him to
      // set his own PIN the moment he lands
      usingDefaultPin: developer.pin === DEVELOPER_DEFAULT_PIN,
      token,
    })
    setSessionCookie(res, token, req)
    void maybeAutoBackup()
    return res
  } catch (err) {
    return errorResponse(err)
  }
}
