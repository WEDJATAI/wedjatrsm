import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ApiError, derivePermissions, errorResponse, hashPassword, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { ROLES } from '@/lib/constants'

// Never expose passwordHash in responses.
const USER_SAFE_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  roleId: true,
  roleRecord: { select: { name: true, permissions: true, active: true } },
  pin: true,
  active: true,
  // R17: payroll — hourly wage (EGP/h, null = not in payroll)
  hourlyRate: true,
  createdAt: true,
}

type UserRowWithRole = {
  id: number
  email: string
  name: string
  role: string
  roleId: number | null
  roleRecord: { name: string; permissions: string; active: boolean } | null
  pin: string | null
  active: boolean
  hourlyRate: number | null
  createdAt: Date
}

/** User row + derived role info (roleName / permissions) for the API. */
function serializeUser(user: UserRowWithRole) {
  const roleName = user.roleId ? (user.roleRecord?.name ?? null) : null
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    roleId: user.roleId,
    roleName,
    permissions: derivePermissions(
      user.role,
      user.roleRecord?.active ? user.roleRecord.permissions : null,
    ),
    pin: user.pin,
    active: user.active,
    hourlyRate: user.hourlyRate,
    createdAt: user.createdAt,
  }
}

/** R16 hardening: quick-login PINs are login credentials — cleartext values
 *  are only returned to full admins. Non-admin holders of the 'users'
 *  permission (e.g. an HR-style custom role) see null (they can still SET a
 *  new PIN via create/edit — the value they typed is what staff will use). */
function pinForSession(
  pin: string | null,
  sessionRole: string,
): string | null {
  return sessionRole === 'admin' ? pin : null
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

/** Returns a normalized PIN (exactly 6 digits), null to clear, or undefined when absent. */
function parsePin(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  const pin = typeof value === 'number' ? String(value) : value
  if (typeof pin !== 'string') throw new ApiError('PIN must be exactly 6 digits', 400)
  const trimmed = pin.trim()
  if (trimmed === '') return null
  if (!/^\d{6}$/.test(trimmed)) {
    throw new ApiError('PIN must be exactly 6 digits', 400)
  }
  return trimmed
}

/**
 * Validate the roleId payload against the effective role.
 * - 'custom' requires a roleId that exists and is active (else 400 'Role not found')
 * - a roleId sent with a non-custom role is rejected
 * Returns the roleId to persist (null when not custom).
 */
async function resolveRoleId(role: string, body: Record<string, unknown>): Promise<number | null> {
  const raw = body.roleId
  if (raw === undefined || raw === null) {
    if (role === 'custom') throw new ApiError('Role not found', 400)
    return null
  }
  if (role !== 'custom') {
    throw new ApiError('roleId can only be set when role is custom', 400)
  }
  const roleId = Number(raw)
  if (!Number.isInteger(roleId)) throw new ApiError('Role not found', 400)
  const roleRecord = await db.customRole.findFirst({
    where: { id: roleId, active: true },
    select: { id: true },
  })
  if (!roleRecord) throw new ApiError('Role not found', 400)
  return roleId
}

export async function GET(req: NextRequest) {
  try {
    const session = await requireAuth(req, ['admin', 'users'])
    const users = await db.user.findMany({
      orderBy: { createdAt: 'asc' },
      select: USER_SAFE_SELECT,
    })
    return NextResponse.json({
      users: users.map((u) => {
        const s = serializeUser(u)
        return { ...s, pin: pinForSession(s.pin, session.role) }
      }),
    })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    // `session` = the acting admin; `user` below = the created row (audit
    // logs the ACTOR; the target user's name/email go into the details)
    const session = await requireAuth(req, ['admin', 'users'])
    const body = await readBody(req)

    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const email =
      typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    const password = typeof body.password === 'string' ? body.password : ''
    const role = typeof body.role === 'string' ? body.role.trim() : ''
    const pin = parsePin(body.pin)

    if (!name) throw new ApiError('Name is required', 400)
    if (!email) throw new ApiError('Email is required', 400)
    if (password.length < 4) {
      throw new ApiError('Password must be at least 4 characters', 400)
    }
    if (!(ROLES as readonly string[]).includes(role)) {
      throw new ApiError(`Role must be one of: ${ROLES.join(', ')}`, 400)
    }

    const roleId = await resolveRoleId(role, body)

    const passwordHash = await hashPassword(password)

    try {
      const user = await db.user.create({
        data: { name, email, passwordHash, role, pin, roleId },
        select: USER_SAFE_SELECT,
      })
      const serialized = serializeUser(user)
      // the actor just supplied this PIN — safe to echo back to them once
      serialized.pin = pinForSession(serialized.pin, session.role) ?? pin ?? null

      await logAudit({
        user: session,
        action: 'user.create',
        entity: 'user',
        entityId: serialized.id,
        details: `Created user ${serialized.name} (${serialized.email}) — role ${
          serialized.role === 'custom'
            ? `custom (${serialized.roleName ?? '?'})`
            : serialized.role
        }`,
      })

      return NextResponse.json({ user: serialized })
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ApiError('Email already exists', 409)
      }
      throw err
    }
  } catch (err) {
    return errorResponse(err)
  }
}
