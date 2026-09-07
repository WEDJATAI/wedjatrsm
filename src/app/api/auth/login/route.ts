import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  createSessionToken,
  derivePermissions,
  errorResponse,
  setSessionCookie,
  verifyPassword,
} from '@/lib/auth'
import { checkRateLimit, clientIp, resetRateLimit } from '@/lib/rate-limit'

type LoginUser = {
  id: number
  email: string
  name: string
  role: string
  roleId: number | null
  roleRecord: { name: string; permissions: string; active: boolean } | null
  passwordHash: string
  active: boolean
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

    // Hardening: rate-limit attempts per IP + identifier (10 failures / 5 min)
    const rlKey = `login:${clientIp(req)}:${(pin || email).slice(0, 60)}`
    const rl = checkRateLimit(rlKey, 10, 5 * 60 * 1000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: `Too many attempts — try again in ${rl.retryAfterSec}s` },
        { status: 429 },
      )
    }

    let user: LoginUser | null = null

    if (pin) {
      // PIN quick-login: exact match on an active user
      user = await db.user.findFirst({
        where: { pin, active: true },
        include: { roleRecord: { select: { name: true, permissions: true, active: true } } },
      })
    } else {
      const found = await db.user.findFirst({
        where: { email },
        include: { roleRecord: { select: { name: true, permissions: true, active: true } } },
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
      return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 })
    }

    const roleRecord = user.roleId ? user.roleRecord : null
    const permissions = derivePermissions(
      user.role,
      roleRecord?.active ? roleRecord.permissions : null,
    )
    const roleName = roleRecord?.name ?? null

    const token = await createSessionToken({
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      permissions,
      roleName,
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
      },
      // Raw token for the client-side Bearer fallback (used when cookies are
      // unavailable, e.g. cross-site preview iframes). Kept in localStorage.
      token,
    })
    setSessionCookie(res, token, req)
    return res
  } catch (err) {
    return errorResponse(err)
  }
}
