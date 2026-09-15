import { NextRequest, NextResponse } from 'next/server'
import { SignJWT, jwtVerify } from 'jose'
import bcrypt from 'bcryptjs'
import { appendFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { db } from '@/lib/db'
import { BUILTIN_ROLE_PERMISSIONS } from '@/lib/constants'

export const SESSION_COOKIE = 'rms_session'
const SESSION_MAX_AGE = 60 * 60 * 24 * 7 // 7 days

/**
 * R16 security hardening: the historic hardcoded dev fallback ('rms-dev-secret-…')
 * was effectively a committed authentication bypass — anyone could forge session
 * tokens with it. Now, when JWT_SECRET is absent, a crypto-random per-installation
 * secret is generated, cached for the process lifetime, and persisted to .env so
 * future boots (and packaged Windows installs) keep stable sessions.
 */
let cachedSecret: Uint8Array | null = null
function getSecret(): Uint8Array {
  if (cachedSecret) return cachedSecret
  const fromEnv = process.env.JWT_SECRET
  if (fromEnv && fromEnv.trim().length >= 16) {
    cachedSecret = new TextEncoder().encode(fromEnv)
    return cachedSecret
  }
  const randomSecret = randomBytes(48).toString('hex')
  let persisted = false
  try {
    appendFileSync('.env', `\n# R16: generated session signing secret\nJWT_SECRET=${randomSecret}\n`)
    persisted = true
  } catch {
    // read-only filesystem → in-memory only for this boot
  }
  process.env.JWT_SECRET = randomSecret
  console.warn(
    `[auth] JWT_SECRET was not configured — generated a per-installation secret` +
      (persisted ? ' and persisted it to .env' : ' (in-memory only; set JWT_SECRET for stable sessions across restarts)'),
  )
  cachedSecret = new TextEncoder().encode(randomSecret)
  return cachedSecret
}

export type SessionPayload = {
  userId: number
  email: string
  name: string
  role: string
  /** granted module permissions (pos / kitchen / reports / ...) */
  permissions: string[]
  /** display name of the custom role when role === 'custom' */
  roleName: string | null
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10)
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash)
}

/**
 * Derive the module permission list for a user.
 * - admin / waiter / kitchen use the built-in grants
 * - 'custom' users read their permissions from the CustomRole record
 */
export function derivePermissions(
  role: string,
  customPermissions: string | null | undefined,
): string[] {
  if (role === 'admin') return BUILTIN_ROLE_PERMISSIONS.admin
  if (role === 'waiter') return BUILTIN_ROLE_PERMISSIONS.waiter
  if (role === 'kitchen') return BUILTIN_ROLE_PERMISSIONS.kitchen
  if (!customPermissions) return []
  return customPermissions
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
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
    // Tolerate legacy tokens signed with older payload shapes ({ id } / no permissions)
    const raw = payload as Record<string, unknown>
    const rawId: unknown = raw.userId ?? raw.id
    const rawPerms = Array.isArray(raw.permissions) ? raw.permissions : []
    return {
      userId: Number(rawId),
      email: String(raw.email ?? ''),
      name: String(raw.name ?? ''),
      role: String(raw.role ?? 'waiter'),
      permissions: rawPerms.map(String),
      roleName: typeof raw.roleName === 'string' ? raw.roleName : null,
    }
  } catch {
    return null
  }
}

/** Session user row shape (DB + derived permissions). */
export type SessionUserRow = {
  id: number
  email: string
  name: string
  role: string
  roleId: number | null
  roleName: string | null
  permissions: string[]
}

/** Load a user by id and derive their permissions (null if missing/inactive). */
export async function loadSessionUser(userId: number): Promise<SessionUserRow | null> {
  const user = await db.user.findFirst({
    where: { id: userId, active: true },
    include: { roleRecord: { select: { name: true, permissions: true, active: true } } },
  })
  if (!user) return null
  const roleRecord = user.roleId ? user.roleRecord : null
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    roleId: user.roleId,
    roleName: roleRecord?.name ?? null,
    permissions: derivePermissions(
      user.role,
      roleRecord?.active ? roleRecord.permissions : null,
    ),
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
  // Ensure user still exists and is active (fresh DB read also picks up role edits)
  const user = await loadSessionUser(payload.userId)
  if (!user) return null
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    permissions: user.permissions,
    roleName: user.roleName,
  }
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
 * Guard an API route. `allowed` may contain:
 *  - classic role names ('admin' | 'waiter' | 'kitchen') — legacy behavior
 *  - module permission keys ('pos', 'reports', 'inventory', …) — satisfied when
 *    the user's derived permission list contains it
 * The admin role always passes. An empty/omitted list only requires a session.
 */
export async function requireAuth(
  req: NextRequest,
  allowed?: string[],
): Promise<SessionPayload> {
  const user = await getSessionUser(req)
  if (!user) throw new ApiError('Unauthorized', 401)
  if (allowed && allowed.length > 0) {
    if (user.role === 'admin') return user
    if (allowed.includes(user.role)) return user // classic role match
    const hasPermission = user.permissions.some((p) => allowed.includes(p))
    if (hasPermission) return user
    throw new ApiError('Forbidden: insufficient role', 403)
  }
  return user
}

/** Convert thrown errors into a consistent JSON error response. */
export function errorResponse(err: unknown): NextResponse {
  if (err instanceof ApiError) {
    return NextResponse.json({ error: err.message }, { status: err.status })
  }
  // R16 hardening: 500s used to echo raw error messages (Prisma/filesystem
  // internals) to clients. The details stay in the server log only.
  console.error('[api-error]', err)
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
}
