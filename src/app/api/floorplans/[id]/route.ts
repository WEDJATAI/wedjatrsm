// /api/floorplans/[id] — partial floor plan update (admin)

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { parseId, serializeFloorPlans } from '@/lib/orders'
import { emitOutboxEvent } from '@/lib/hybrid-sync/outbox'
import { FLOOR_SIZE_MAX, FLOOR_SIZE_MIN, isFloorShape } from '@/lib/floor-geometry'

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
    const data: { name?: string; active?: boolean; widthUnits?: number; heightUnits?: number; floorShape?: string } = {}
    if (body?.name != null) {
      const name = String(body.name).trim()
      if (!name) throw new ApiError('Floor plan name cannot be empty', 400)
      data.name = name
    }
    if (body?.active != null) {
      data.active = Boolean(body.active)
    }
    // p21: floor geometry — the owner customizes the room's size & shape
    if (body?.widthUnits != null) {
      const w = Number(body.widthUnits)
      if (!Number.isFinite(w) || w < FLOOR_SIZE_MIN || w > FLOOR_SIZE_MAX) {
        throw new ApiError(`widthUnits must be between ${FLOOR_SIZE_MIN} and ${FLOOR_SIZE_MAX}`, 400)
      }
      data.widthUnits = w
    }
    if (body?.heightUnits != null) {
      const h = Number(body.heightUnits)
      if (!Number.isFinite(h) || h < FLOOR_SIZE_MIN || h > FLOOR_SIZE_MAX) {
        throw new ApiError(`heightUnits must be between ${FLOOR_SIZE_MIN} and ${FLOOR_SIZE_MAX}`, 400)
      }
      data.heightUnits = h
    }
    if (body?.floorShape != null) {
      if (!isFloorShape(body.floorShape)) throw new ApiError('Invalid floorShape', 400)
      data.floorShape = body.floorShape
    }

    // p21: ride the hybrid outbox — floor-plan edits converge to every
    // terminal and the cloud (atomic with the business write).
    const floorPlan = await db.$transaction(async (tx) => {
      const updated = await tx.floorPlan.update({ where: { id: floorPlanId }, data })
      await emitOutboxEvent(tx, {
        entity: 'FloorPlan',
        entityId: updated.id,
        operation: 'update',
        row: updated,
      })
      return updated
    })

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
