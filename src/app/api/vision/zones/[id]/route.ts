// /api/vision/zones/[id] — update / delete a zone (admin + 'vision')
// PUT supports optimistic concurrency via an optional `version` field.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { parseId } from '@/lib/orders'
import { VISION_ZONE_KINDS } from '@/lib/constants'
import { serializeZone } from '@/lib/vision'
import { ZONE_LIST_INCLUDE, validatePolygon } from '../route'

type Ctx = { params: Promise<{ id: string }> }

/**
 * When a zone stops mapping a table (edit or delete) and no other active
 * zone covers it, that table's vision state degrades to 'unknown' —
 * never 'empty' (peopleCount/confidence keep the last-known values).
 */
async function resetTableVisionIfUnmapped(tableId: number, excludeZoneId: number): Promise<void> {
  const other = await db.visionZone.findFirst({
    where: { tableId, active: true, id: { not: excludeZoneId } },
    select: { id: true },
  })
  if (other) return
  await db.visionTableState.upsert({
    where: { tableId },
    update: { state: 'unknown', stateSince: new Date(), pendingEmptySince: null },
    create: { tableId, state: 'unknown', stateSince: new Date(), pendingEmptySince: null },
  })
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  try {
    const user = await requireAuth(req, ['vision'])
    const { id } = await ctx.params
    const zoneId = parseId(id, 'zone id')
    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })

    const zone = await db.visionZone.findUnique({
      where: { id: zoneId },
      include: ZONE_LIST_INCLUDE,
    })
    if (!zone) throw new ApiError('Zone not found', 404)

    // Optimistic concurrency: reject stale edits outright
    if (body?.version !== undefined && body.version != null) {
      const version = Number(body.version)
      if (!Number.isInteger(version)) throw new ApiError('version must be an integer', 400)
      if (version !== zone.version) {
        throw new ApiError('Zone was modified by someone else — reload and retry', 409)
      }
    }

    const data: {
      cameraId?: number
      name?: string
      kind?: string
      tableId?: number | null
      polygon?: string
      seats?: number | null
      active?: boolean
      version?: number
      updatedBy?: string
    } = { version: zone.version + 1, updatedBy: user.name }
    const changed: string[] = []

    if (body?.cameraId !== undefined) {
      const cameraId = Number(body.cameraId)
      if (!Number.isInteger(cameraId)) throw new ApiError('cameraId must be a numeric id', 400)
      const camera = await db.visionCamera.findUnique({ where: { id: cameraId } })
      if (!camera || !camera.active) throw new ApiError('Camera not found or inactive', 400)
      data.cameraId = camera.id
      changed.push('cameraId')
    }
    if (body?.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (name.length < 1 || name.length > 60) {
        throw new ApiError('Zone name must be between 1 and 60 characters', 400)
      }
      data.name = name
      changed.push('name')
    }
    if (body?.kind !== undefined) {
      if (typeof body.kind !== 'string' || !(VISION_ZONE_KINDS as readonly string[]).includes(body.kind)) {
        throw new ApiError(`kind must be one of: ${VISION_ZONE_KINDS.join(', ')}`, 400)
      }
      data.kind = body.kind
      changed.push('kind')
    }
    if (body?.tableId !== undefined) {
      if (body.tableId == null) {
        data.tableId = null
      } else {
        const tId = Number(body.tableId)
        if (!Number.isInteger(tId)) throw new ApiError('tableId must be a numeric id', 400)
        const table = await db.restaurantTable.findUnique({ where: { id: tId } })
        if (!table || !table.active) throw new ApiError('Table not found or inactive', 400)
        data.tableId = table.id
      }
      changed.push('tableId')
    }
    if (body?.polygon !== undefined) {
      data.polygon = JSON.stringify(validatePolygon(body.polygon))
      changed.push('polygon')
    }
    if (body?.seats !== undefined) {
      if (body.seats == null) {
        data.seats = null
      } else {
        const s = Number(body.seats)
        if (!Number.isInteger(s) || s < 0 || s > 20) {
          throw new ApiError('seats must be an integer between 0 and 20', 400)
        }
        data.seats = s
      }
      changed.push('seats')
    }
    if (body?.active !== undefined) {
      if (typeof body.active !== 'boolean') throw new ApiError('active must be a boolean', 400)
      data.active = body.active
      changed.push('active')
    }

    const updated = await db.visionZone.update({
      where: { id: zoneId },
      data,
      include: ZONE_LIST_INCLUDE,
    })

    // The old mapped table (if the mapping changed/removed) degrades to
    // 'unknown' when nothing else observes it.
    const newTableId = updated.tableId
    if (zone.tableId != null && newTableId !== zone.tableId) {
      await resetTableVisionIfUnmapped(zone.tableId, zoneId)
    }

    await logAudit({
      user,
      action: 'vision.zoneUpdate',
      entity: 'vision',
      entityId: zoneId,
      details: `Zone ${zone.name} updated (${changed.join(', ') || 'no changes'}, v${zone.version} → v${updated.version})`,
    })
    return NextResponse.json({ zone: serializeZone(updated) })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  try {
    const user = await requireAuth(req, ['vision'])
    const { id } = await ctx.params
    const zoneId = parseId(id, 'zone id')

    const zone = await db.visionZone.findUnique({
      where: { id: zoneId },
      include: ZONE_LIST_INCLUDE,
    })
    if (!zone) throw new ApiError('Zone not found', 404)

    // If this zone was the table's only observer, its vision state degrades
    // to 'unknown' (never 'empty').
    if (zone.tableId != null) {
      await resetTableVisionIfUnmapped(zone.tableId, zoneId)
    }

    await db.visionZone.delete({ where: { id: zoneId } })
    await logAudit({
      user,
      action: 'vision.zoneDelete',
      entity: 'vision',
      entityId: zoneId,
      details: `Zone ${zone.name} deleted${zone.tableId ? ` (table ${zone.table?.name ?? zone.tableId} unmapped)` : ''}`,
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return errorResponse(err)
  }
}
