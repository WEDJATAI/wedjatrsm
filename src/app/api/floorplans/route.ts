// /api/floorplans — list (any authenticated) + create (admin)

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { serializeFloorPlans } from '@/lib/orders'
import { emitOutboxEvent } from '@/lib/hybrid-sync/outbox'
import { FLOOR_SIZE_MAX, FLOOR_SIZE_MIN, isFloorShape } from '@/lib/floor-geometry'

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req)
    const includeAll = new URL(req.url).searchParams.get('all') === '1'
    const floorPlans = await db.floorPlan.findMany({
      where: includeAll ? {} : { active: true },
      orderBy: { id: 'asc' },
      include: { tables: { where: { active: true }, orderBy: { name: 'asc' } } },
    })
    return NextResponse.json({ floorPlans: await serializeFloorPlans(floorPlans) })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAuth(req, ['admin', 'floorplans'])
    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })
    const name = String(body?.name ?? '').trim()
    if (!name) throw new ApiError('Floor plan name is required', 400)

    // p21: optional floor geometry on creation (defaults keep the classic
    // full-canvas rectangle)
    const geometry: { widthUnits?: number; heightUnits?: number; floorShape?: string } = {}
    if (body?.widthUnits != null) {
      const w = Number(body.widthUnits)
      if (!Number.isFinite(w) || w < FLOOR_SIZE_MIN || w > FLOOR_SIZE_MAX) {
        throw new ApiError(`widthUnits must be between ${FLOOR_SIZE_MIN} and ${FLOOR_SIZE_MAX}`, 400)
      }
      geometry.widthUnits = w
    }
    if (body?.heightUnits != null) {
      const h = Number(body.heightUnits)
      if (!Number.isFinite(h) || h < FLOOR_SIZE_MIN || h > FLOOR_SIZE_MAX) {
        throw new ApiError(`heightUnits must be between ${FLOOR_SIZE_MIN} and ${FLOOR_SIZE_MAX}`, 400)
      }
      geometry.heightUnits = h
    }
    if (body?.floorShape != null) {
      if (!isFloorShape(body.floorShape)) throw new ApiError('Invalid floorShape', 400)
      geometry.floorShape = body.floorShape
    }

    // p21: floor-plan writes ride the hybrid outbox so the owner's edits
    // converge to every terminal (and the cloud) — same contract as orders.
    const floorPlan = await db.$transaction(async (tx) => {
      const created = await tx.floorPlan.create({ data: { name, ...geometry } })
      await emitOutboxEvent(tx, {
        entity: 'FloorPlan',
        entityId: created.id,
        operation: 'create',
        row: created,
      })
      return created
    })
    return NextResponse.json({
      floorPlan: {
        id: floorPlan.id,
        name: floorPlan.name,
        backgroundImage: floorPlan.backgroundImage,
        widthUnits: floorPlan.widthUnits,
        heightUnits: floorPlan.heightUnits,
        floorShape: floorPlan.floorShape,
        active: floorPlan.active,
        tables: [],
      },
    })
  } catch (err) {
    return errorResponse(err)
  }
}
