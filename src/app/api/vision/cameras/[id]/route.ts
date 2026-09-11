// /api/vision/cameras/[id] — update / delete a camera (admin + 'vision')

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { parseId } from '@/lib/orders'
import { serializeCamera } from '@/lib/vision'
import { CAMERA_LIST_INCLUDE, validateStreamUrl } from '../route'

type Ctx = { params: Promise<{ id: string }> }

export async function PUT(req: NextRequest, ctx: Ctx) {
  try {
    const user = await requireAuth(req, ['vision'])
    const { id } = await ctx.params
    const cameraId = parseId(id, 'camera id')
    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })

    const camera = await db.visionCamera.findUnique({
      where: { id: cameraId },
      include: CAMERA_LIST_INCLUDE,
    })
    if (!camera) throw new ApiError('Camera not found', 404)

    const data: {
      name?: string
      streamUrl?: string | null
      floorPlanId?: number | null
      status?: string
      active?: boolean
    } = {}
    const changed: string[] = []

    if (body?.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (name.length < 1 || name.length > 60) {
        throw new ApiError('Camera name must be between 1 and 60 characters', 400)
      }
      data.name = name
      changed.push('name')
    }
    if (body?.streamUrl !== undefined) {
      data.streamUrl = validateStreamUrl(body.streamUrl)
      changed.push('streamUrl')
    }
    if (body?.floorPlanId !== undefined) {
      if (body.floorPlanId == null) {
        data.floorPlanId = null
      } else {
        const fpId = Number(body.floorPlanId)
        if (!Number.isInteger(fpId)) throw new ApiError('floorPlanId must be a numeric id', 400)
        const plan = await db.floorPlan.findUnique({ where: { id: fpId } })
        if (!plan || !plan.active) throw new ApiError('Floor plan not found or inactive', 400)
        data.floorPlanId = plan.id
      }
      changed.push('floorPlanId')
    }
    if (body?.active !== undefined) {
      if (typeof body.active !== 'boolean') throw new ApiError('active must be a boolean', 400)
      data.active = body.active
      changed.push('active')
      if (body.active === false) {
        data.status = 'disabled'
      } else if (body.active === true) {
        // reactivation: a camera must re-report before it is trusted online
        data.status = 'offline'
      }
    }

    const updated = await db.visionCamera.update({
      where: { id: cameraId },
      data,
      include: CAMERA_LIST_INCLUDE,
    })
    await logAudit({
      user,
      action: 'vision.cameraUpdate',
      entity: 'vision',
      entityId: cameraId,
      details: `Camera ${updated.code} updated (${changed.join(', ') || 'no changes'})`,
    })
    return NextResponse.json({ camera: serializeCamera(updated) })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  try {
    const user = await requireAuth(req, ['vision'])
    const { id } = await ctx.params
    const cameraId = parseId(id, 'camera id')

    const camera = await db.visionCamera.findUnique({
      where: { id: cameraId },
      include: { _count: { select: { zones: true } } },
    })
    if (!camera) throw new ApiError('Camera not found', 404)
    const zoneCount = camera._count.zones
    if (zoneCount > 0) {
      throw new ApiError(`Camera still has ${zoneCount} zone(s)`, 409)
    }

    await db.visionCamera.delete({ where: { id: cameraId } })
    await logAudit({
      user,
      action: 'vision.cameraDelete',
      entity: 'vision',
      entityId: cameraId,
      details: `Camera ${camera.code} deleted`,
    })
    return NextResponse.json({ ok: true })
  } catch (err) {
    return errorResponse(err)
  }
}
