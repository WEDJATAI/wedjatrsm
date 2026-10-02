import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/constants'

type RoleRowWithCount = {
  id: number
  name: string
  permissions: string
  active: boolean
  createdAt: Date
  _count: { users: number }
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

/** CustomRole shape for the API: permissions split into a string[] + userCount. */
function serializeRole(role: RoleRowWithCount) {
  return {
    id: role.id,
    name: role.name,
    permissions: role.permissions
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean),
    active: role.active,
    userCount: role._count.users,
    createdAt: role.createdAt.toISOString(),
  }
}

/** Validate the permissions payload: must be an array of known module keys. */
function parsePermissions(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new ApiError('permissions must be an array', 400)
  }
  const seen = new Set<string>()
  for (const raw of value) {
    const perm = typeof raw === 'string' ? raw.trim() : ''
    if (!perm || !(PERMISSIONS as readonly string[]).includes(perm)) {
      throw new ApiError(`Invalid permission: ${typeof raw === 'string' ? raw : String(raw)}`, 400)
    }
    seen.add(perm)
  }
  return Array.from(seen)
}

function parseName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (name.length < 2 || name.length > 40) {
    throw new ApiError('Role name must be between 2 and 40 characters', 400)
  }
  return name
}

export async function GET(req: NextRequest) {
  try {
    // R16: role structures are only needed by user/role management — no
    // reason for waiter/kitchen sessions to enumerate them.
    await requireAuth(req, ['admin', 'roles', 'users'])
    const roles = await db.customRole.findMany({
      orderBy: { id: 'asc' },
      include: { _count: { select: { users: true } } },
    })
    return NextResponse.json({ roles: roles.map(serializeRole) })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireAuth(req, ['admin', 'roles'])
    const body = await readBody(req)

    const name = parseName(body.name)
    const permissions = parsePermissions(body.permissions)

    try {
      const role = await db.customRole.create({
        data: { name, permissions: permissions.join(',') },
        include: { _count: { select: { users: true } } },
      })
      const serialized = serializeRole(role)

      await logAudit({
        user,
        action: 'role.create',
        entity: 'role',
        entityId: serialized.id,
        details: `Created role ${serialized.name} (permissions: ${serialized.permissions.join(', ')})`,
      })

      return NextResponse.json({ role: serialized })
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ApiError('Role name already exists', 409)
      }
      throw err
    }
  } catch (err) {
    return errorResponse(err)
  }
}
