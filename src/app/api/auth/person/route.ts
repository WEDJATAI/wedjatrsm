// POST /api/auth/person — select WHO is operating this account right now.
// R19 person attribution: the chosen person is embedded into a freshly
// issued session token, so every subsequent action (check issue, item
// move, payment, audit…) is stamped with the actual staff member.
// { personId: number }  → attribute the session to that active person
// { personId: null }    → back to account-level attribution (no person)
// The person MUST belong to the authenticated account — you can never
// attribute your session to someone else's staff.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  ApiError,
  createSessionToken,
  errorResponse,
  getSessionUser,
  requireAuth,
  setSessionCookie,
} from '@/lib/auth'

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth(req)
    const body: Record<string, unknown> = await req.json().catch(() => ({}))

    const rawPersonId: unknown = body?.personId
    if (rawPersonId !== null && !(Number.isInteger(Number(rawPersonId)) && Number(rawPersonId) > 0)) {
      throw new ApiError('personId must be a positive integer or null', 400)
    }

    let personId: number | null = null
    let personName: string | null = null
    if (rawPersonId !== null) {
      const person = await db.person.findFirst({
        where: { id: Number(rawPersonId), userId: session.userId, active: true },
        select: { id: true, name: true },
      })
      if (!person) {
        throw new ApiError('Person not found on this account', 404)
      }
      personId = person.id
      personName = person.name
    }

    const token = await createSessionToken({
      userId: session.userId,
      email: session.email,
      name: session.name,
      role: session.role,
      permissions: session.permissions,
      roleName: session.roleName,
      personId,
      personName,
    })
    const res = NextResponse.json({
      user: {
        id: session.userId,
        email: session.email,
        name: session.name,
        role: session.role,
        permissions: session.permissions,
        roleName: session.roleName,
        personId,
        personName,
      },
      token,
    })
    setSessionCookie(res, token, req)
    return res
  } catch (err) {
    return errorResponse(err)
  }
}

// Convenience for the client: the active people list for the current account.
export async function GET(req: NextRequest) {
  try {
    const session = await getSessionUser(req)
    if (!session) throw new ApiError('Unauthorized', 401)
    const people = await db.person.findMany({
      where: { userId: session.userId, active: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    })
    return NextResponse.json({
      people,
      personId: session.personId,
      personName: session.personName,
    })
  } catch (err) {
    return errorResponse(err)
  }
}
