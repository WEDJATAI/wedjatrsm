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
    return {
      userId: Number(payload.userId),
      email: String(payload.email),
      name: String(payload.name),
      role: String(payload.role),
    }
  } catch {
    return null
  }
}

/** Read the current session user from the request cookie (returns null if not authed). */
export async function getSessionUser(req: NextRequest): Promise<SessionPayload | null> {
  const token = req.cookies.get(SESSION_COOKIE)?.value
  if (!token) return null
  const payload = await verifySessionToken(token)
  if (!payload) return null
  // Ensure user still exists and is active
  const user = await db.user.findFirst({
    where: { id: payload.userId, active: true },
    select: { id: true, email: true, name: true, role: true },
  })
  return user ? { userId: user.id, email: user.email, name: user.name, role: user.role } : null
}

export function setSessionCookie(res: NextResponse, token: string) {
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  })
}

export function clearSessionCookie(res: NextResponse) {
  res.cookies.set(SESSION_COOKIE, '', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
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
