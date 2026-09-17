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
  // R19: the actual people operating this account
  people: { select: { id: true, name: true, active: true }, orderBy: { name: 'asc' as const } },
} satisfies Prisma.UserSelect

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
  people: { id: number; name: string; active: boolean }[]
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
    // R19: people registered under this account
    people: user.people,
  }
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

/** A roleId must reference an existing, active CustomRole (400 'Role not found' otherwise). */
async function requireActiveRole(roleId: number): Promise<void> {
  const roleRecord = await db.customRole.findFirst({
    where: { id: roleId, active: true },
    select: { id: true },
  })
  if (!roleRecord) throw new ApiError('Role not found', 400)
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await requireAuth(req, ['admin', 'users'])
    const { id } = await params
    const userId = Number(id)
    if (!Number.isInteger(userId)) {
      throw new ApiError('Invalid user id', 400)
    }

    // NB: getSessionUser currently returns the DB row shape ({ id, ... })
    // although it is typed as SessionPayload ({ userId, ... }) — read the
    // session user id defensively so this guard works with either shape.
    const rawSession = session as unknown as { userId?: number; id?: number }
    const sessionUserId = rawSession.userId ?? rawSession.id

    const existing = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, roleId: true, hourlyRate: true },
    })
    if (!existing) throw new ApiError('User not found', 404)

    const body = await readBody(req)
    const data: Prisma.UserUncheckedUpdateInput = {}

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) {
        throw new ApiError('Name cannot be empty', 400)
      }
      data.name = body.name.trim()
    }

    let roleAfterUpdate: string | undefined
    if (body.role !== undefined) {
      if (
        typeof body.role !== 'string' ||
        !(ROLES as readonly string[]).includes(body.role.trim())
      ) {
        throw new ApiError(`Role must be one of: ${ROLES.join(', ')}`, 400)
      }
      roleAfterUpdate = body.role.trim()
      data.role = roleAfterUpdate
    }

    if (body.pin !== undefined) {
      data.pin = parsePin(body.pin)
    }

    // R17 payroll: hourly rate (EGP/h). null or '' clears it; otherwise a
    // finite number ≥ 0. Audited separately as payroll.rateUpdate on change.
    let newHourlyRate: number | null | undefined
    if (body.hourlyRate !== undefined) {
      if (body.hourlyRate === null || body.hourlyRate === '') {
        newHourlyRate = null
      } else if (typeof body.hourlyRate === 'number' || typeof body.hourlyRate === 'string') {
        const rate = Number(body.hourlyRate)
        if (!Number.isFinite(rate) || rate < 0) {
          throw new ApiError('Hourly rate must be a number ≥ 0', 400)
        }
        newHourlyRate = rate
      } else {
        throw new ApiError('Hourly rate must be a number ≥ 0', 400)
      }
      data.hourlyRate = newHourlyRate
    }

    if (body.active !== undefined) {
      if (typeof body.active !== 'boolean') {
        throw new ApiError('Active must be true or false', 400)
      }
      if (!body.active && userId === sessionUserId) {
        throw new ApiError('You cannot deactivate your own account', 400)
      }
      data.active = body.active
    }

    // Password is only re-hashed when a non-empty string is provided.
    if (typeof body.password === 'string' && body.password !== '') {
      if (body.password.length < 4) {
        throw new ApiError('Password must be at least 4 characters', 400)
      }
      data.passwordHash = await hashPassword(body.password)
    }

    // ── roleId handling (custom roles) ─────────────────────────────────
    // - roleId with an effective non-custom role → 400
    // - effective custom role must resolve to an active CustomRole
    // - leaving the custom role clears any stale roleId
    const effectiveRole = roleAfterUpdate ?? existing.role

    if (body.roleId !== undefined && body.roleId !== null) {
      if (effectiveRole !== 'custom') {
        throw new ApiError('roleId can only be set when role is custom', 400)
      }
      const roleId = Number(body.roleId)
      if (!Number.isInteger(roleId)) throw new ApiError('Role not found', 400)
      await requireActiveRole(roleId)
      data.roleId = roleId
    } else if (body.roleId === null) {
      if (effectiveRole === 'custom') {
        // custom requires a role — clearing it outright is not allowed
        throw new ApiError('Role not found', 400)
      }
      data.roleId = null
    } else if (roleAfterUpdate !== undefined && roleAfterUpdate !== 'custom') {
      // switching away from custom → drop the stale role link
      data.roleId = null
    } else if (roleAfterUpdate === 'custom') {
      // switching to custom without a new roleId → keep the existing link
      const keepId = existing.roleId
      if (keepId === null) throw new ApiError('Role not found', 400)
      await requireActiveRole(keepId)
    }

    const user = await db.user.update({
      where: { id: userId },
      data,
      select: USER_SAFE_SELECT,
    })
    const serialized = serializeUser(user)
    // R16: PIN visibility rule (same as GET) — cleartext only for admins.
    // Exception: when the actor just SET a new PIN, echo the value they
    // typed back to them once (they need it to tell the staff member).
    if (session.role !== 'admin') {
      serialized.pin =
        typeof data.pin === 'string' ? data.pin : data.pin === null ? null : serialized.pin
    }

    // Audit — the actor's session + the TARGET user's name/email in the
    // details (never the password hash; 'password' only as a key name).
    // Deactivating a user is this app's soft delete → 'user.delete'.
    const changedKeys: string[] = []
    if (data.name !== undefined) changedKeys.push('name')
    if (data.role !== undefined) changedKeys.push('role')
    if (data.pin !== undefined) changedKeys.push('pin')
    if (data.passwordHash !== undefined) changedKeys.push('password')
    if (data.active !== undefined) changedKeys.push('active')
    if (data.roleId !== undefined) changedKeys.push('roleId')
    if (data.hourlyRate !== undefined) changedKeys.push('hourlyRate')
    const softDeleted = body.active === false
    await logAudit({
      user: session,
      action: softDeleted ? 'user.delete' : 'user.update',
      entity: 'user',
      entityId: userId,
      details: `${softDeleted ? 'Deactivated' : 'Updated'} user ${serialized.name} (${serialized.email})${
        changedKeys.length > 0 ? ` — keys: ${changedKeys.join(', ')}` : ''
      }`,
    })

    // R17 payroll: dedicated audit trail for wage changes (old → new).
    if (newHourlyRate !== undefined && newHourlyRate !== existing.hourlyRate) {
      const fmt = (v: number | null) => (v === null ? 'not set' : `${v} EGP/h`)
      await logAudit({
        user: session,
        action: 'payroll.rateUpdate',
        entity: 'payroll',
        entityId: userId,
        details: `Hourly rate for ${serialized.name} (${serialized.email}): ${fmt(
          existing.hourlyRate,
        )} → ${fmt(newHourlyRate)}`,
      })
    }

    return NextResponse.json({ user: serialized })
  } catch (err) {
    return errorResponse(err)
  }
}
