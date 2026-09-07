import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'

// Shift edits are partial; deactivation (active=false) is the ONLY delete
// mechanism — attendance history keeps referencing the shift rows.
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

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
  if (!Number.isInteger(n)) throw new ApiError('Invalid shift id', 400)
  return n
}

function validateTime(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new ApiError(`${field} is required (HH:MM 24-hour format)`, 400)
  }
  const time = value.trim()
  if (!TIME_RE.test(time)) {
    throw new ApiError(`${field} must be a valid HH:MM time (24-hour)`, 400)
  }
  return time
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAuth(req, ['admin', 'settings'])
    const { id } = await params
    const shiftId = parseIdParam(id)

    const existing = await db.shift.findUnique({
      where: { id: shiftId },
      select: { id: true },
    })
    if (!existing) throw new ApiError('Shift not found', 404)

    const body = await readBody(req)
    const data: Prisma.ShiftUpdateInput = {}

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) {
        throw new ApiError('Name cannot be empty', 400)
      }
      if (body.name.trim().length > 60) {
        throw new ApiError('Name must be at most 60 characters', 400)
      }
      data.name = body.name.trim()
    }

    if (body.startTime !== undefined) {
      data.startTime = validateTime(body.startTime, 'startTime')
    }

    if (body.endTime !== undefined) {
      data.endTime = validateTime(body.endTime, 'endTime')
    }

    if (body.active !== undefined) {
      if (typeof body.active !== 'boolean') {
        throw new ApiError('Active must be true or false', 400)
      }
      data.active = body.active
    }

    const shift = await db.shift.update({ where: { id: shiftId }, data })
    return NextResponse.json({
      shift: {
        id: shift.id,
        name: shift.name,
        startTime: shift.startTime,
        endTime: shift.endTime,
        active: shift.active,
      },
    })
  } catch (err) {
    return errorResponse(err)
  }
}
