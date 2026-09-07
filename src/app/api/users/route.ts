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

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['admin'])
    const users = await db.user.findMany({
      orderBy: { createdAt: 'asc' },
      select: USER_SAFE_SELECT,
    })
    return NextResponse.json({ users })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAuth(req, ['admin'])
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

    const passwordHash = await hashPassword(password)

    try {
      const user = await db.user.create({
        data: { name, email, passwordHash, role, pin },
        select: USER_SAFE_SELECT,
      })
      return NextResponse.json({ user })
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
