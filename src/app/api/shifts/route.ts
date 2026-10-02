import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'

// Shifts are attendance reference windows ("HH:MM" 24h). endTime < startTime
// means the shift wraps past midnight (overnight) — allowed.
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

type ShiftRow = {
  id: number
  name: string
  startTime: string
  endTime: string
  active: boolean
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

function serializeShift(shift: ShiftRow) {
  return {
    id: shift.id,
    name: shift.name,
    startTime: shift.startTime,
    endTime: shift.endTime,
    active: shift.active,
  }
}

/** Validate an "HH:MM" 24-hour time string (400 with a clear message otherwise). */
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

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req)
    const shifts = await db.shift.findMany({ orderBy: { id: 'asc' } })
    return NextResponse.json({ shifts: shifts.map(serializeShift) })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAuth(req, ['admin', 'settings'])
    const body = await readBody(req)

    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) throw new ApiError('Name is required', 400)
    if (name.length > 60) {
      throw new ApiError('Name must be at most 60 characters', 400)
    }

    const startTime = validateTime(body.startTime, 'startTime')
    const endTime = validateTime(body.endTime, 'endTime')
    // endTime < startTime = overnight shift — explicitly allowed, no extra check.

    const shift = await db.shift.create({
      data: { name, startTime, endTime },
    })
    return NextResponse.json({ shift: serializeShift(shift) })
  } catch (err) {
    return errorResponse(err)
  }
}
