// /api/users/[id]/persons — manage the actual PEOPLE operating a user
// account (R19). Admin-only: the shared-login roster ("who works under
// this profile") is administrative data.
//   GET  → list all people on the account (active + inactive)
//   POST → { name } register a new person

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'

type Ctx = { params: Promise<{ id: string }> }

function parsePersonName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (name.length < 2 || name.length > 60) {
    throw new ApiError('Person name must be between 2 and 60 characters', 400)
  }
  return name
}

export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    await requireAuth(req, ['admin', 'users'])
    const { id } = await ctx.params
    const userId = Number(id)
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new ApiError('Invalid user id', 400)
    }
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true },
    })
    if (!user) throw new ApiError('User not found', 404)

    const people = await db.person.findMany({
      where: { userId },
      select: { id: true, name: true, active: true, createdAt: true },
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
    })
    return NextResponse.json({
      people: people.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() })),
    })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const session = await requireAuth(req, ['admin', 'users'])
    const { id } = await ctx.params
    const userId = Number(id)
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new ApiError('Invalid user id', 400)
    }
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, role: true },
    })
    if (!user) throw new ApiError('User not found', 404)

    const body: Record<string, unknown> = await req.json().catch(() => ({}))
    const name = parsePersonName(body?.name)

    // Guard against exact-duplicate roster entries (same name, same account).
    const existing = await db.person.findFirst({
      where: { userId, name },
      select: { id: true },
    })
    if (existing) {
      throw new ApiError('A person with this name already exists on the account', 409)
    }

    const person = await db.person.create({
      data: { userId, name },
      select: { id: true, name: true, active: true, createdAt: true },
    })
    await logAudit({
      user: session,
      action: 'person.create',
      entity: 'person',
      entityId: person.id,
      details: `${person.name} added to account ${user.name} (#${userId})`,
    })
    return NextResponse.json(
      { person: { ...person, createdAt: person.createdAt.toISOString() } },
      { status: 201 },
    )
  } catch (err) {
    return errorResponse(err)
  }
}
