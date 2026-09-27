// /api/auth/register — public self-registration with NAME + PIN (R22).
//
// A new staff member walks up to any terminal, enters their name, picks a
// service role and creates a 6-digit PIN — from that moment the PIN alone
// signs them in (same quick-login as the seeded accounts).
//
// Design decisions (deliberate):
//  - SERVICE ROLES ONLY. 'waiter', 'kitchen' and admin-approved custom
//    roles are self-registerable; 'admin' and custom roles holding
//    admin-only modules (users / roles / settings / audit) can NEVER be
//    minted from a public endpoint — privileged accounts stay
//    admin-provisioned via the Users screen.
//  - The email (schema-unique login identifier) is auto-generated from the
//    name — the staff member never types one. It is a real, unique address
//    in the @local.rsm namespace, so the account is fully manageable from
//    the admin Users screen afterwards.
//  - passwordHash is a hash of a random unguessable string: email+password
//    sign-in is intentionally locked for self-registered accounts until an
//    admin sets a real password.
//  - PIN uniqueness is enforced across ALL users (active or not) — PIN
//    quick-login matches on the PIN alone, so two accounts sharing a PIN
//    would make login ambiguous.
//  - R19 person attribution: the registrant becomes the first (and only)
//    Person on the account → the server auto-embeds them in the session,
//    exactly like the seeded single-person accounts (zero extra taps).
//  - Rate limited: 5 registrations / 10 min per IP (mass account creation
//    is blocked; a real hiring day never approaches this).

import { NextRequest, NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'
import { db } from '@/lib/db'
import {
  ApiError,
  createSessionToken,
  derivePermissions,
  errorResponse,
  hashPassword,
  setSessionCookie,
  type SessionPayload,
} from '@/lib/auth'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'

const PIN_LENGTH = 6
const NAME_MIN = 2
const NAME_MAX = 60
const REGISTER_RATE_MAX = 5
const REGISTER_RATE_WINDOW_MS = 10 * 60 * 1000
/** custom roles holding any of these modules are NOT self-registerable */
const ADMIN_ONLY_MODULES = new Set(['users', 'roles', 'settings', 'audit'])

export type RegisterRoleOption = { value: string; label: string }

/** Service roles a new staff member may self-register as. */
async function allowedRoles(): Promise<RegisterRoleOption[]> {
  const options: RegisterRoleOption[] = [
    { value: 'waiter', label: 'Waiter' },
    { value: 'kitchen', label: 'Kitchen' },
  ]
  let customs: { id: number; name: string; permissions: string }[] = []
  try {
    customs = await db.customRole.findMany({
      where: { active: true },
      select: { id: true, name: true, permissions: true },
    })
  } catch {
    // custom roles table unavailable → built-ins still work
  }
  customs
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((cr) => {
      const perms = cr.permissions
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
      if (perms.some((p) => ADMIN_ONLY_MODULES.has(p))) return
      options.push({ value: `custom:${cr.id}`, label: cr.name })
    })
  return options
}

/** GET → the self-registerable role list (public; feeds the UI picker). */
export async function GET() {
  try {
    return NextResponse.json({ roles: await allowedRoles() })
  } catch (err) {
    return errorResponse(err)
  }
}

/** strip control chars, collapse whitespace, cap length */
function sanitizeName(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NAME_MAX)
}

/** "Sara  Mahmoud!" → "sara.mohamed" (empty → "staff") */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '.')
    .replace(/\.+/g, '.')
    .replace(/^\.+|\.+$/g, '')
  return slug || 'staff'
}

/** name-based @local.rsm address that is guaranteed unique */
async function uniqueEmail(base: string): Promise<string> {
  for (let attempt = 0; attempt < 25; attempt++) {
    const suffix =
      attempt === 0
        ? String(1000 + Math.floor(Math.random() * 9000))
        : `${Date.now().toString(36)}${attempt}`
    const email = `${base}.${suffix}@local.rsm`
    const exists = await db.user.findUnique({
      where: { email },
      select: { id: true },
    })
    if (!exists) return email
  }
  throw new ApiError('Could not allocate an account email — please retry', 500)
}

// Local audit writer — lib/audit.ts action/entity unions are frozen
// (foundation-owned); the AuditLog columns are plain strings, so this
// mirrors logAudit's fire-and-forget semantics for 'user.register'.
async function logRegisterAudit(user: {
  id: number
  name: string
  role: string
  roleName: string | null
  email: string
}): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        userId: user.id,
        userName: user.name,
        action: 'user.register',
        entity: 'user',
        entityId: user.id,
        details: `Self-registration — name "${user.name}", role ${
          user.roleName ?? user.role
        }, email ${user.email}`,
      },
    })
  } catch (err) {
    console.error('[audit-log] failed to record user.register', err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const ip = clientIp(req)
    const rl = checkRateLimit(
      `register:${ip}`,
      REGISTER_RATE_MAX,
      REGISTER_RATE_WINDOW_MS,
    )
    if (!rl.ok) {
      return NextResponse.json(
        {
          error: `Too many registrations from this network — try again in ${rl.retryAfterSec}s`,
        },
        { status: 429 },
      )
    }

    let body: Record<string, unknown> = {}
    try {
      const parsed: unknown = await req.json()
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed) === false) {
        body = parsed as Record<string, unknown>
      }
    } catch {
      // missing/invalid JSON → field validation below returns a clean 400
    }

    // ── name ──
    const name = sanitizeName(body.name)
    if (name.length < NAME_MIN) {
      throw new ApiError(`Name must be at least ${NAME_MIN} characters`, 400)
    }

    // ── PIN (6 digits, typed twice) ──
    const pin = typeof body.pin === 'string' ? body.pin.trim() : ''
    if (!new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)) {
      throw new ApiError(`PIN must be exactly ${PIN_LENGTH} digits`, 400)
    }
    const confirmPin =
      typeof body.confirmPin === 'string' ? body.confirmPin.trim() : ''
    if (pin !== confirmPin) {
      throw new ApiError('PINs do not match', 400)
    }
    // PIN quick-login matches on the PIN alone → must be unambiguous
    const pinTaken = await db.user.findFirst({
      where: { pin },
      select: { id: true },
    })
    if (pinTaken) {
      throw new ApiError('That PIN is already in use — choose another one', 409)
    }

    // ── role (service roles only — never admin) ──
    const rawRole =
      typeof body.role === 'string' && body.role ? body.role : 'waiter'
    let role = 'waiter'
    let roleId: number | null = null
    let customPermissions: string | null = null
    let roleName: string | null = null
    if (rawRole === 'waiter' || rawRole === 'kitchen') {
      role = rawRole
    } else if (rawRole.startsWith('custom:')) {
      const id = Number(rawRole.slice('custom:'.length))
      if (!Number.isInteger(id) || id < 1) {
        throw new ApiError('Invalid role', 400)
      }
      const cr = await db.customRole.findUnique({ where: { id } })
      if (!cr || !cr.active) {
        throw new ApiError('That role is no longer available', 400)
      }
      const perms = cr.permissions
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
      if (perms.some((p) => ADMIN_ONLY_MODULES.has(p))) {
        throw new ApiError(
          'That role is not available for self-registration',
          400,
        )
      }
      role = 'custom'
      roleId = cr.id
      customPermissions = cr.permissions
      roleName = cr.name
    } else {
      throw new ApiError('Invalid role', 400)
    }

    // ── create user + first person atomically ──
    const email = await uniqueEmail(slugify(name))
    // random unguessable password → email/password sign-in stays locked
    // until an admin provisions a real one from the Users screen
    const passwordHash = await hashPassword(randomBytes(24).toString('hex'))

    const created = await db.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { email, passwordHash, name, role, roleId, pin, active: true },
      })
      // R19 person attribution — the registrant is the account's first
      // (and only) person → auto-embedded in the session below.
      const person = await tx.person.create({
        data: { userId: user.id, name, active: true },
      })
      return { user, person }
    })

    const permissions = derivePermissions(role, customPermissions)
    const session: SessionPayload = {
      userId: created.user.id,
      email,
      name,
      role,
      permissions,
      roleName,
      personId: created.person.id,
      personName: created.person.name,
    }
    const token = await createSessionToken(session)

    void logRegisterAudit({
      id: created.user.id,
      name,
      role,
      roleName,
      email,
    })

    // Same response shape as POST /api/auth/login — the client's
    // finishLogin() flow (person picker included) works unchanged.
    const res = NextResponse.json({
      user: {
        id: created.user.id,
        email,
        name,
        role,
        permissions,
        roleName,
        personId: created.person.id,
        personName: created.person.name,
      },
      people: [{ id: created.person.id, name: created.person.name }],
      token,
    })
    setSessionCookie(res, token, req)
    return res
  } catch (err) {
    return errorResponse(err)
  }
}
