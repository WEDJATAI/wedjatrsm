// /api/floorspaces — custom floor-space creation (admin) — r56
//
// A floor space is an owner-defined zone on a floor plan (shisha lounge,
// bar counter, stage, VIP corner…) rendered as a 3D platform next to the
// tables. Writes ride the hybrid outbox so every terminal + the cloud
// converge on the arrangement (same contract as tables/floor plans).

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { FLOOR_SPACE_KINDS } from '@/lib/constants'
import { serializeFloorSpace } from '@/lib/orders'
import { emitOutboxEvent } from '@/lib/hybrid-sync/outbox'

/** Space size bounds, in % of the floor box. */
export const SPACE_SIZE_MIN = 4
export const SPACE_SIZE_MAX = 60

function parsePercent(value: unknown, label: string): number {
  const num = Number(value)
  if (!Number.isFinite(num) || num < 0 || num > 100) {
    throw new ApiError(`${label} must be a number between 0 and 100`, 400)
  }
  return num
}

function parseSize(value: unknown, label: string, fallback: number): number {
  if (value == null) return fallback
  const num = Number(value)
  if (!Number.isFinite(num) || num < SPACE_SIZE_MIN || num > SPACE_SIZE_MAX) {
    throw new ApiError(`${label} must be between ${SPACE_SIZE_MIN} and ${SPACE_SIZE_MAX}`, 400)
  }
  return num
}

function parseRotation(value: unknown): number {
  if (value == null) return 0
  const num = Number(value)
  if (!Number.isFinite(num) || num < -180 || num > 180) {
    throw new ApiError('rotation must be between -180 and 180 degrees', 400)
  }
  return num
}

export async function POST(req: NextRequest) {
  try {
    await requireAuth(req, ['admin', 'floorplans'])
    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })

    const floorPlanId = Number(body?.floorPlanId)
    if (!Number.isInteger(floorPlanId) || floorPlanId <= 0) {
      throw new ApiError('floorPlanId is required', 400)
    }
    const floorPlan = await db.floorPlan.findUnique({ where: { id: floorPlanId } })
    if (!floorPlan) throw new ApiError('Floor plan not found', 404)

    const name = String(body?.name ?? '').trim()
    if (!name) throw new ApiError('Space name is required', 400)

    let kind = 'lounge'
    if (body?.kind != null) {
      kind = String(body.kind)
      if (!(FLOOR_SPACE_KINDS as readonly string[]).includes(kind)) {
        throw new ApiError('Invalid space kind', 400)
      }
    }

    const positionX = body?.positionX == null ? 50 : parsePercent(body.positionX, 'positionX')
    const positionY = body?.positionY == null ? 50 : parsePercent(body.positionY, 'positionY')
    const widthUnits = parseSize(body?.widthUnits, 'widthUnits', 18)
    const depthUnits = parseSize(body?.depthUnits, 'depthUnits', 18)
    const rotation = parseRotation(body?.rotation)

    // r56: space writes ride the hybrid outbox (atomic with the business
    // write) so the owner's layout converges to every terminal.
    const space = await db.$transaction(async (tx) => {
      const created = await tx.floorSpace.create({
        data: { floorPlanId, name, kind, positionX, positionY, widthUnits, depthUnits, rotation },
      })
      await emitOutboxEvent(tx, {
        entity: 'FloorSpace',
        entityId: created.id,
        operation: 'create',
        row: created,
      })
      return created
    })
    return NextResponse.json({ space: serializeFloorSpace(space) })
  } catch (err) {
    return errorResponse(err)
  }
}
