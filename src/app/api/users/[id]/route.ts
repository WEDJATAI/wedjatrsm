import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ApiError, derivePermissions, errorResponse, hashPassword, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { ROLES } from '@/lib/constants'
import { deletedAtFromEmail, isDeletedEmail, tombstoneEmail } from '@/lib/user-deletion'

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
  // R27: the manager's account — the one super admin
  isSuperAdmin: true,
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
  isSuperAdmin: boolean
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
    isSuperAdmin: user.isSuperAdmin,
    hourlyRate: user.hourlyRate,
    createdAt: user.createdAt,
    // r34: derived archive-deletion marker (null for live users)
    deletedAt: deletedAtFromEmail(user.email),
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

/**
 * r34: delete a user account — the safe restaurant way.
 *
 * Two modes, chosen by the account's operational history:
 *
 * 1. PERMANENT — the account has NO history anywhere (no orders served,
 *    no attendance, no cash drawer sessions/entries, no waste logs, no
 *    issued checks through its persons): the row (and its persons, which
 *    cascade) is hard-deleted. Persons are deactivated first so the
 *    reconcile delta (Person rides rsm-hybrid/1) marks them inactive on
 *    the cloud side before they vanish locally.
 *
 * 2. ARCHIVED — the account HAS history: financial records must survive.
 *    The row stays (name kept → old reports stay readable) but the
 *    account is tombstoned: inactive, PIN cleared, password randomized,
 *    email replaced by a unique `deleted.<id>.<epoch>@deleted.rsm` marker
 *    (frees the original address). The UI hides tombstones behind a
 *    “show deleted” toggle; login is impossible.
 *
 * Guards: an admin can never delete their own account, the manager
 * (super admin) or the developer account — same protection as PUT.
 * Audit: 'user.hardDelete' / 'user.archiveDelete' with full counts.
 */
export async function DELETE(
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

    // NB: getSessionUser returns the DB row shape defensively (see PUT).
    const rawSession = session as unknown as { userId?: number; id?: number }
    const sessionUserId = rawSession.userId ?? rawSession.id

    if (userId === sessionUserId) {
      throw new ApiError('You cannot delete your own account', 400)
    }

    const existing = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        isSuperAdmin: true,
      },
    })
    if (!existing) throw new ApiError('User not found', 404)

    if (existing.isSuperAdmin) {
      throw new ApiError('The manager account cannot be deleted', 403)
    }
    if (existing.role === 'developer') {
      throw new ApiError('The developer account cannot be deleted', 403)
    }
    if (isDeletedEmail(existing.email)) {
      throw new ApiError('This user is already deleted', 409)
    }

    // ── operational-history census ────────────────────────────────────
    const [ordersServed, attendanceRows, cashSessions, cashEntries, wasteLogs, personRows] =
      await Promise.all([
        db.order.count({ where: { userId } }),
        db.attendance.count({ where: { userId } }),
        db.cashDrawerSession.count({ where: { userId } }),
        db.cashDrawerEntry.count({ where: { userId } }),
        db.wasteLog.count({ where: { userId } }),
        db.person.findMany({
          where: { userId },
          select: { id: true, _count: { select: { issuedChecks: true } } },
        }),
      ])
    const issuedChecks = personRows.reduce((sum, p) => sum + p._count.issuedChecks, 0)

    // Persons are deactivated first in BOTH modes so the reconcile delta
    // (Person is revision-aware, rides rsm-hybrid/1) carries the
    // deactivation to the cloud even when the rows then vanish locally.
    await db.person.updateMany({
      where: { userId },
      data: { active: false, updatedAt: new Date() },
    })

    const counts = {
      ordersServed,
      attendanceRows,
      cashSessions,
      cashEntries,
      wasteLogs,
      issuedChecks,
      persons: personRows.length,
    }
    const hasHistory =
      ordersServed + attendanceRows + cashSessions + cashEntries + wasteLogs + issuedChecks > 0

    if (!hasHistory) {
      // ── permanent delete (persons cascade — they carry no checks) ──
      await db.user.delete({ where: { id: userId } })
      await logAudit({
        user: session,
        action: 'user.hardDelete',
        entity: 'user',
        entityId: userId,
        details: `Permanently deleted user ${existing.name} (${existing.email}) — no operational history (persons released: ${personRows.length})`,
      })
      return NextResponse.json({ deleted: true, mode: 'permanent' as const, counts })
    }

    // ── archive delete — history preserved, login revoked ──
    await db.user.update({
      where: { id: userId },
      data: {
        active: false,
        pin: null,
        passwordHash: await hashPassword(randomUUID()),
        email: tombstoneEmail(userId),
      },
    })
    await logAudit({
      user: session,
      action: 'user.archiveDelete',
      entity: 'user',
      entityId: userId,
      details:
        `Archive-deleted user ${existing.name} (${existing.email}) — history preserved ` +
        `(orders ${ordersServed}, attendance ${attendanceRows}, cash sessions ${cashSessions}, ` +
        `cash entries ${cashEntries}, waste ${wasteLogs}, issued checks ${issuedChecks}, ` +
        `persons deactivated ${personRows.length}); login revoked, email freed`,
    })
    return NextResponse.json({ deleted: true, mode: 'archived' as const, counts })
  } catch (err) {
    return errorResponse(err)
  }
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
      select: { id: true, role: true, roleId: true, hourlyRate: true, isSuperAdmin: true },
    })
    if (!existing) throw new ApiError('User not found', 404)

    // R27: the manager's account belongs to the manager alone — no other
    // admin (or anyone else) may edit, re-pin, demote or deactivate the
    // one super admin. He manages his account through his own tools.
    if (existing.isSuperAdmin && userId !== sessionUserId) {
      throw new ApiError(
        'The manager account can only be modified by the manager himself',
        403,
      )
    }

    // p11-d: the developer's account belongs to the developer alone —
    // same protection as the manager's row. No other admin (or anyone
    // else) may edit, re-pin or deactivate the one developer; he manages
    // his account through his own PIN tools.
    if (existing.role === 'developer' && userId !== sessionUserId) {
      throw new ApiError(
        'The developer account can only be modified by the developer himself',
        403,
      )
    }

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
