// /api/floorplans/[id] — partial floor plan update (admin)

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { parseId, serializeFloorPlans } from '@/lib/orders'

type Ctx = { params: Promise<{ id: string }> }

export async function PUT(req: NextRequest, ctx: Ctx) {
  try {
    await requireAuth(req, ['admin', 'floorplans'])
    const { id } = await ctx.params
    const floorPlanId = parseId(id, 'floor plan id')

    const existing = await db.floorPlan.findUnique({ where: { id: floorPlanId } })
    if (!existing) throw new ApiError('Floor plan not found', 404)

    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })
    const data: { name?: string; active?: boolean } = {}
    if (body?.name != null) {
      const name = String(body.name).trim()
      if (!name) throw new ApiError('Floor plan name cannot be empty', 400)
      data.name = name
    }
    if (body?.active != null) {
      data.active = Boolean(body.active)
    }

    const floorPlan = await db.floorPlan.update({ where: { id: floorPlanId }, data })

    // Return the same shape as GET /api/floorplans (active tables + extras)
    const [serialized] = await serializeFloorPlans([
      {
        ...floorPlan,
        tables: await db.restaurantTable.findMany({
          where: { floorPlanId, active: true },
          orderBy: { name: 'asc' },
        }),
      },
    ])
    return NextResponse.json({ floorPlan: serialized })
  } catch (err) {
    return errorResponse(err)
  }
}
