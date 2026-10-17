// /api/floorspaces/[id] — partial floor-space update (admin) — r56
//
// Mirrors /api/tables/[id]: partial update of any subset of the editable
// fields; "removal" is the soft-delete convention (active=false). Every
// write rides the hybrid outbox (atomic with the business write).

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { FLOOR_SPACE_KINDS } from '@/lib/constants'
import { parseId, serializeFloorSpace } from '@/lib/orders'
import { emitOutboxEvent } from '@/lib/hybrid-sync/outbox'

type Ctx = { params: Promise<{ id: string }> }

const SPACE_SIZE_MIN = 4
const SPACE_SIZE_MAX = 60

export async function PUT(req: NextRequest, ctx: Ctx) {
  try {
    await requireAuth(req, ['admin', 'floorplans'])
    const { id } = await ctx.params
    const spaceId = parseId(id, 'floor space id')

    const existing = await db.floorSpace.findUnique({ where: { id: spaceId } })
    if (!existing) throw new ApiError('Floor space not found', 404)

    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })

    const data: {
      name?: string
      kind?: string
      positionX?: number
      positionY?: number
      widthUnits?: number
      depthUnits?: number
      rotation?: number
      active?: boolean
    } = {}

    if (body?.name != null) {
      const name = String(body.name).trim()
      if (!name) throw new ApiError('Space name cannot be empty', 400)
      data.name = name
    }
    if (body?.kind != null) {
      const kind = String(body.kind)
      if (!(FLOOR_SPACE_KINDS as readonly string[]).includes(kind)) {
        throw new ApiError('Invalid space kind', 400)
      }
      data.kind = kind
    }
    if (body?.positionX != null) {
      const x = Number(body.positionX)
      if (!Number.isFinite(x) || x < 0 || x > 100) {
        throw new ApiError('positionX must be a number between 0 and 100', 400)
      }
      data.positionX = x
    }
    if (body?.positionY != null) {
      const y = Number(body.positionY)
      if (!Number.isFinite(y) || y < 0 || y > 100) {
        throw new ApiError('positionY must be a number between 0 and 100', 400)
      }
      data.positionY = y
    }
    if (body?.widthUnits != null) {
      const w = Number(body.widthUnits)
      if (!Number.isFinite(w) || w < SPACE_SIZE_MIN || w > SPACE_SIZE_MAX) {
        throw new ApiError(`widthUnits must be between ${SPACE_SIZE_MIN} and ${SPACE_SIZE_MAX}`, 400)
      }
      data.widthUnits = w
    }
    if (body?.depthUnits != null) {
      const d = Number(body.depthUnits)
      if (!Number.isFinite(d) || d < SPACE_SIZE_MIN || d > SPACE_SIZE_MAX) {
        throw new ApiError(`depthUnits must be between ${SPACE_SIZE_MIN} and ${SPACE_SIZE_MAX}`, 400)
      }
      data.depthUnits = d
    }
    if (body?.rotation != null) {
      const r = Number(body.rotation)
      if (!Number.isFinite(r) || r < -180 || r > 180) {
        throw new ApiError('rotation must be between -180 and 180 degrees', 400)
      }
      data.rotation = r
    }
    if (body?.active != null) {
      data.active = Boolean(body.active)
    }

    const space = await db.$transaction(async (tx) => {
      const updated = await tx.floorSpace.update({ where: { id: spaceId }, data })
      await emitOutboxEvent(tx, {
        entity: 'FloorSpace',
        entityId: updated.id,
        operation: 'update',
        row: updated,
      })
      return updated
    })
    return NextResponse.json({ space: serializeFloorSpace(space) })
  } catch (err) {
    return errorResponse(err)
  }
}
