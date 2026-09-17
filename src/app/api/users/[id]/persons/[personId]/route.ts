// /api/users/[id]/persons/[personId] — edit a person on an account (R19).
// Admin-only. Rename and activate/deactivate only: history (issued checks,
// audit rows) references persons, so deletion is deliberately NOT offered —
// deactivate instead. Renames propagate to future sessions; past audit rows
// keep their name snapshot by design.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'

type Ctx = { params: Promise<{ id: string; personId: string }> }

export async function PUT(req: NextRequest, ctx: Ctx) {
  try {
    const session = await requireAuth(req, ['admin', 'users'])
    const { id, personId } = await ctx.params
    const userId = Number(id)
    const pid = Number(personId)
    if (!Number.isInteger(userId) || userId <= 0) {
      throw new ApiError('Invalid user id', 400)
    }
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new ApiError('Invalid person id', 400)
    }

    const person = await db.person.findFirst({
      where: { id: pid, userId },
      select: { id: true, name: true, active: true, user: { select: { name: true } } },
    })
    if (!person) throw new ApiError('Person not found on this account', 404)

    const body: Record<string, unknown> = await req.json().catch(() => ({}))

    const data: { name?: string; active?: boolean } = {}
    if (body?.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (name.length < 2 || name.length > 60) {
        throw new ApiError('Person name must be between 2 and 60 characters', 400)
      }
      const duplicate = await db.person.findFirst({
        where: { userId, name, id: { not: pid } },
        select: { id: true },
      })
      if (duplicate) {
        throw new ApiError('A person with this name already exists on the account', 409)
      }
      data.name = name
    }
    if (body?.active !== undefined) {
      if (typeof body.active !== 'boolean') {
        throw new ApiError('active must be a boolean', 400)
      }
      data.active = body.active
    }
    if (Object.keys(data).length === 0) {
      throw new ApiError('Nothing to update (name and/or active required)', 400)
    }

    const updated = await db.person.update({
      where: { id: pid },
      data,
      select: { id: true, name: true, active: true, createdAt: true },
    })
    const changes: string[] = []
    if (data.name !== undefined && data.name !== person.name) changes.push(`renamed "${person.name}" → "${data.name}"`)
    if (data.active !== undefined && data.active !== person.active) {
      changes.push(data.active ? 'reactivated' : 'deactivated')
    }
    await logAudit({
      user: session,
      action: 'person.update',
      entity: 'person',
      entityId: pid,
      details: `${person.user.name}'s person ${person.name}: ${changes.join(', ') || 'no change'}`,
    })
    return NextResponse.json({
      person: { ...updated, createdAt: updated.createdAt.toISOString() },
    })
  } catch (err) {
    return errorResponse(err)
  }
}
