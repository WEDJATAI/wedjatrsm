// /api/tables/[id]/clear — two-phase manual table turnover:
//   1. 'bus'   : a 'paid' or 'deferred' table (bill settled / client left)
//                is sent to cleaning → status 'dirty' (AMBER on the floor).
//   2. 'clean' : a 'dirty' table that has been cleaned → status 'free'.
// The action may be passed in the body ({ action: 'bus' | 'clean' }); when
// omitted it is derived from the current status. Guarded: tables with an
// open order can never be cleared this way (open orders force 'occupied').

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { parseId, serializeTable } from '@/lib/orders'

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const user = await requireAuth(req, ['waiter', 'admin', 'pos'])
    const { id } = await ctx.params
    const tableId = parseId(id, 'table id')

    let action: 'bus' | 'clean' | undefined
    try {
      const body = (await req.json()) as { action?: unknown }
      if (body?.action === 'bus' || body?.action === 'clean') action = body.action
    } catch {
      // no JSON body — derive the action from the current status below
    }

    const table = await db.restaurantTable.findUnique({ where: { id: tableId } })
    if (!table || !table.active) throw new ApiError('Table not found', 404)

    const derived: 'bus' | 'clean' | null =
      table.status === 'paid' || table.status === 'deferred'
        ? 'bus'
        : table.status === 'dirty'
          ? 'clean'
          : null
    const effective = action ?? derived
    if (effective == null) {
      throw new ApiError('Only paid, deferred or dirty (needs cleaning) tables can be cleared', 400)
    }
    if (effective === 'bus' && table.status !== 'paid' && table.status !== 'deferred') {
      throw new ApiError('Only paid or deferred tables can be sent to cleaning', 400)
    }
    if (effective === 'clean' && table.status !== 'dirty') {
      throw new ApiError('Only tables marked as needing cleaning can be marked cleaned', 400)
    }

    const updated = await db.restaurantTable.update({
      where: { id: tableId },
      data: { status: effective === 'bus' ? 'dirty' : 'free' },
    })

    await logAudit({
      user,
      action: effective === 'bus' ? 'table.bus' : 'table.clean',
      entity: 'table',
      entityId: tableId,
      details:
        effective === 'bus'
          ? `Table ${table.name} sent to cleaning (was ${table.status})`
          : `Table ${table.name} cleaned and back to free`,
    })

    return NextResponse.json({ table: serializeTable(updated) })
  } catch (err) {
    return errorResponse(err)
  }
}
