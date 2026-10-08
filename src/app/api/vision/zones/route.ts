// /api/vision/zones — zone registry (admin + 'vision' permission)

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { VISION_ZONE_KINDS } from '@/lib/constants'
import { serializeZone } from '@/lib/vision'
import type { VisionZonePoint } from '@/lib/types'

export const ZONE_LIST_INCLUDE = {
  camera: { select: { code: true, floorPlanId: true } },
  table: { select: { name: true, floorPlanId: true } },
} as const

/** Validate + clamp a polygon (3..24 normalized points). */
export function validatePolygon(raw: unknown): VisionZonePoint[] {
  if (!Array.isArray(raw) || raw.length < 3 || raw.length > 24) {
    throw new ApiError('polygon must be an array of 3..24 points {x, y}', 400)
  }
  const points: VisionZonePoint[] = []
  for (const entry of raw) {
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ApiError('polygon points must be objects {x, y}', 400)
    }
    const { x, y } = entry as Record<string, unknown>
    const nx = Number(x)
    const ny = Number(y)
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
      throw new ApiError('polygon point coordinates must be finite numbers in 0..1', 400)
    }
    // clamp into the normalized camera frame
    points.push({ x: Math.min(1, Math.max(0, nx)), y: Math.min(1, Math.max(0, ny)) })
  }
  return points
}

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['vision'])
    const zones = await db.visionZone.findMany({
      include: ZONE_LIST_INCLUDE,
      orderBy: [{ camera: { code: 'asc' } }, { name: 'asc' }],
    })
    return NextResponse.json({ zones: zones.map(serializeZone) })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireAuth(req, ['vision'])
    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })

    const cameraId = Number(body?.cameraId)
    if (!Number.isInteger(cameraId)) throw new ApiError('cameraId must be a numeric id', 400)
    const camera = await db.visionCamera.findUnique({ where: { id: cameraId } })
    if (!camera || !camera.active) throw new ApiError('Camera not found or inactive', 400)

    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (name.length < 1 || name.length > 60) {
      throw new ApiError('Zone name must be between 1 and 60 characters', 400)
    }

    if (typeof body?.kind !== 'string' || !(VISION_ZONE_KINDS as readonly string[]).includes(body.kind)) {
      throw new ApiError(`kind must be one of: ${VISION_ZONE_KINDS.join(', ')}`, 400)
    }

    let tableId: number | null = null
    if (body?.tableId != null) {
      const tId = Number(body.tableId)
      if (!Number.isInteger(tId)) throw new ApiError('tableId must be a numeric id', 400)
      const table = await db.restaurantTable.findUnique({ where: { id: tId } })
      if (!table || !table.active) throw new ApiError('Table not found or inactive', 400)
      tableId = table.id
    }

    const polygon = validatePolygon(body?.polygon)

    let seats: number | null = null
    if (body?.seats != null) {
      const s = Number(body.seats)
      if (!Number.isInteger(s) || s < 0 || s > 20) {
        throw new ApiError('seats must be an integer between 0 and 20', 400)
      }
      seats = s
    }

    let active = true
    if (body?.active !== undefined) {
      if (typeof body.active !== 'boolean') throw new ApiError('active must be a boolean', 400)
      active = body.active
    }

    const zone = await db.visionZone.create({
      data: {
        cameraId,
        name,
        kind: body.kind,
        tableId,
        polygon: JSON.stringify(polygon),
        seats,
        active,
        createdBy: user.name,
      },
      include: ZONE_LIST_INCLUDE,
    })
    await logAudit({
      user,
      action: 'vision.zoneCreate',
      entity: 'vision',
      entityId: zone.id,
      details: `Zone ${zone.name} (${zone.kind}) on ${camera.code}${tableId ? ` → table ${zone.table?.name ?? tableId}` : ''} created`,
    })
    return NextResponse.json({ zone: serializeZone(zone) }, { status: 201 })
  } catch (err) {
    return errorResponse(err)
  }
}
