import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { PERMISSIONS } from '@/lib/constants'

// Roles are soft-deleted (active=false). Users keep their roleName but lose
// the derived permissions until reassigned — acceptable per contract.
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

function parseIdParam(id: string): number {
  const n = Number(id)
  if (!Number.isInteger(n)) throw new ApiError('Invalid role id', 400)
  return n
}

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

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireAuth(req, ['admin', 'roles'])
    const { id } = await params
    const roleId = parseIdParam(id)

    const existing = await db.customRole.findUnique({
      where: { id: roleId },
      select: { id: true },
    })
    if (!existing) throw new ApiError('Role not found', 404)

    const body = await readBody(req)
    const data: Prisma.CustomRoleUpdateInput = {}

    if (body.name !== undefined) {
      data.name = parseName(body.name)
    }

    if (body.permissions !== undefined) {
      const permissions = parsePermissions(body.permissions)
      data.permissions = permissions.join(',')
    }

    if (body.active !== undefined) {
      if (typeof body.active !== 'boolean') {
        throw new ApiError('Active must be true or false', 400)
      }
      data.active = body.active
    }

    try {
      const role = await db.customRole.update({
        where: { id: roleId },
        data,
        include: { _count: { select: { users: true } } },
      })

      // Audit — deactivating a role is this app's soft delete → 'role.delete'.
      const changedKeys: string[] = []
      if (data.name !== undefined) changedKeys.push('name')
      if (data.permissions !== undefined) changedKeys.push('permissions')
      if (data.active !== undefined) changedKeys.push('active')
      const softDeleted = body.active === false
      await logAudit({
        user,
        action: softDeleted ? 'role.delete' : 'role.update',
        entity: 'role',
        entityId: roleId,
        details: `${softDeleted ? 'Deactivated' : 'Updated'} role ${role.name}${
          changedKeys.length > 0 ? ` — keys: ${changedKeys.join(', ')}` : ''
        }`,
      })

      return NextResponse.json({
        role: {
          id: role.id,
          name: role.name,
          permissions: role.permissions
            .split(',')
            .map((p) => p.trim())
            .filter(Boolean),
          active: role.active,
          userCount: role._count.users,
          createdAt: role.createdAt.toISOString(),
        },
      })
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
