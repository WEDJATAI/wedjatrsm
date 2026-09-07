import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ApiError, errorResponse, hashPassword, requireAuth } from '@/lib/auth'
import { ROLES } from '@/lib/constants'

// Never expose passwordHash in responses.
const USER_SAFE_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  pin: true,
  active: true,
  createdAt: true,
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

/** Returns a normalized PIN (3-8 digits), null to clear, or undefined when absent. */
function parsePin(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  const pin = typeof value === 'number' ? String(value) : value
  if (typeof pin !== 'string') throw new ApiError('PIN must be 3-8 digits', 400)
  const trimmed = pin.trim()
  if (trimmed === '') return null
  if (!/^\d{3,8}$/.test(trimmed)) {
    throw new ApiError('PIN must be 3-8 digits', 400)
  }
  return trimmed
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
      select: { id: true },
    })
    if (!existing) throw new ApiError('User not found', 404)

    const body = await readBody(req)
    const data: Prisma.UserUpdateInput = {}

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) {
        throw new ApiError('Name cannot be empty', 400)
      }
      data.name = body.name.trim()
    }

    if (body.role !== undefined) {
      if (
        typeof body.role !== 'string' ||
        !(ROLES as readonly string[]).includes(body.role.trim())
      ) {
        throw new ApiError(`Role must be one of: ${ROLES.join(', ')}`, 400)
      }
      data.role = body.role.trim()
    }

    if (body.pin !== undefined) {
      data.pin = parsePin(body.pin)
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

    const user = await db.user.update({
      where: { id: userId },
      data,
      select: USER_SAFE_SELECT,
    })
    return NextResponse.json({ user })
  } catch (err) {
    return errorResponse(err)
  }
}
