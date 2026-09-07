// /api/tables/[id]/clear — mark a 'paid' or 'deferred' table as free
// (waiter/admin clicks the table on the floor once the client has left
// and the table has been cleaned). Guarded: tables with an open order
// can never be cleared this way (open orders force 'occupied' live).

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { parseId, serializeTable } from '@/lib/orders'

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    await requireAuth(req, ['waiter', 'admin', 'pos'])
    const { id } = await ctx.params
    const tableId = parseId(id, 'table id')

    const table = await db.restaurantTable.findUnique({ where: { id: tableId } })
    if (!table || !table.active) throw new ApiError('Table not found', 404)
    if (table.status !== 'paid' && table.status !== 'deferred') {
      throw new ApiError('Only paid or deferred tables can be cleared', 400)
    }

    const updated = await db.restaurantTable.update({
      where: { id: tableId },
      data: { status: 'free' },
    })
    return NextResponse.json({ table: serializeTable(updated) })
  } catch (err) {
    return errorResponse(err)
  }
}
