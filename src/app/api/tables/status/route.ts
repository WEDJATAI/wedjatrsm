// /api/tables/status — POS table polling (any authenticated)

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { errorResponse, requireAuth } from '@/lib/auth'
import { serializeTablesWithOpenOrders } from '@/lib/orders'

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req)
    const tables = await db.restaurantTable.findMany({
      where: { active: true },
      orderBy: [{ floorPlanId: 'asc' }, { name: 'asc' }],
    })
    // One extra query attaches openOrderId/openOrderTotal/itemCount/since
    // for every table and forces live status 'occupied'.
    const result = await serializeTablesWithOpenOrders(tables)
    return NextResponse.json({ tables: result })
  } catch (err) {
    return errorResponse(err)
  }
}
