import { NextRequest, NextResponse } from 'next/server'
import { SignJWT, jwtVerify } from 'jose'
import bcrypt from 'bcryptjs'
import { db } from '@/lib/db'

export const SESSION_COOKIE = 'rms_session'
const SESSION_MAX_AGE = 60 * 60 * 24 * 7 // 7 days

function getSecret(): Uint8Array {
  const secret = process.env.JWT_SECRET ?? 'rms-dev-secret-change-me'
  return new TextEncoder().encode(secret)
}

export type SessionPayload = {
  userId: number
  email: string
  name: string
  role: string
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

export async function createSessionToken(payload: SessionPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .sign(getSecret())
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret())
    // Tolerate legacy tokens signed with an older payload shape ({ id } instead of { userId })
    const rawId: unknown = (payload as Record<string, unknown>).userId ?? (payload as Record<string, unknown>).id
    return {
      userId: Number(rawId),
      email: String(payload.email),
      name: String(payload.name),
      role: String(payload.role),
    }
  } catch {
    return null
  }
}

/** Read the current session user from the request cookie or Authorization header (returns null if not authed). */
export async function getSessionUser(req: NextRequest): Promise<SessionPayload | null> {
  // 1) httpOnly cookie (first-party contexts)
  const cookieToken = req.cookies.get(SESSION_COOKIE)?.value
  let payload = cookieToken ? await verifySessionToken(cookieToken) : null
  // 2) Bearer token fallback (cross-site iframes / previews where cookies are blocked)
  if (!payload) {
    const authHeader = req.headers.get('authorization')
    if (authHeader?.toLowerCase().startsWith('bearer ')) {
      payload = await verifySessionToken(authHeader.slice(7).trim())
    }
  }
  if (!payload) return null
  // Ensure user still exists and is active
  const user = await db.user.findFirst({
    where: { id: payload.userId, active: true },
    select: { id: true, email: true, name: true, role: true },
  })
  return user ? { userId: user.id, email: user.email, name: user.name, role: user.role } : null
}

/**
 * Whether the session cookie must be cross-site capable (SameSite=None; Secure).
 *
 * When the app is embedded in a cross-site iframe (e.g. the sandbox preview panel),
 * browsers refuse to send `SameSite=Lax` cookies back on subresource requests, which
 * makes logins appear to "bounce back" to the login screen. Cross-site contexts here
 * are always served over HTTPS through the platform gateway, so any non-localhost host
 * (or an https x-forwarded-proto) gets a `SameSite=None; Secure` cookie instead.
 */
function needsCrossSiteCookie(req?: NextRequest): boolean {
  const proto = (req?.headers.get('x-forwarded-proto') ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase()
  if (proto === 'https' || req?.nextUrl.protocol === 'https:') return true
  const host = (req?.headers.get('host') ?? '').toLowerCase()
  const isLocalHost =
    !host ||
    host.startsWith('localhost') ||
    host.startsWith('127.0.0.1') ||
    host.startsWith('0.0.0.0') ||
    host.startsWith('[::1]')
  return !isLocalHost
}

export function setSessionCookie(res: NextResponse, token: string, req?: NextRequest) {
  const crossSite = needsCrossSiteCookie(req)
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: crossSite ? 'none' : 'lax',
    secure: crossSite,
    path: '/',
    maxAge: SESSION_MAX_AGE,
  })
}

export function clearSessionCookie(res: NextResponse, req?: NextRequest) {
  const crossSite = needsCrossSiteCookie(req)
  res.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: crossSite ? 'none' : 'lax',
    secure: crossSite,
    path: '/',
    maxAge: 0,
  })
}

export class ApiError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

/**
 * Guard an API route: requires an authenticated user, optionally with one of the given roles.
 * Throws ApiError(401/403) which should be caught and converted via `errorResponse()`.
 */
export async function requireAuth(
  req: NextRequest,
  roles?: string[],
): Promise<SessionPayload> {
  const user = await getSessionUser(req)
  if (!user) throw new ApiError('Unauthorized', 401)
  if (roles && roles.length > 0 && !roles.includes(user.role)) {
    throw new ApiError('Forbidden: insufficient role', 403)
  }
  return user
}

/** Convert thrown errors into a consistent JSON error response. */
export function errorResponse(err: unknown): NextResponse {
  if (err instanceof ApiError) {
    return NextResponse.json({ error: err.message }, { status: err.status })
  }
  const message = err instanceof Error ? err.message : 'Internal server error'
  console.error('[api-error]', err)
  return NextResponse.json({ error: message }, { status: 500 })
}
