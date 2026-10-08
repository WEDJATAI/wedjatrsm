// /api/vision/cameras — camera registry (admin + 'vision' permission)

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { VISION_STREAM_URL_RE } from '@/lib/constants'
import { serializeCamera } from '@/lib/vision'

const CODE_RE = /^[A-Za-z0-9_-]{1,32}$/

export const CAMERA_LIST_INCLUDE = {
  _count: { select: { zones: true } },
  floorPlan: { select: { name: true } },
} as const

/** Validate a streamUrl value: null/'' → null (cleared); string → checked. */
export function validateStreamUrl(value: unknown): string | null {
  if (value == null) return null
  if (typeof value !== 'string') throw new ApiError('streamUrl must be a string', 400)
  const url = value.trim()
  if (url === '') return null
  if (url.includes('@')) {
    throw new ApiError(
      'streamUrl must not embed credentials — camera auth belongs to the edge processor',
      400,
    )
  }
  if (!VISION_STREAM_URL_RE.test(url)) {
    throw new ApiError('Invalid streamUrl — expected an rtsp/rtsps/http/https/onvif URL', 400)
  }
  return url
}

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['vision'])
    const cameras = await db.visionCamera.findMany({
      include: CAMERA_LIST_INCLUDE,
      orderBy: { code: 'asc' },
    })
    return NextResponse.json({ cameras: cameras.map(serializeCamera) })
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

    const code = typeof body?.code === 'string' ? body.code : ''
    if (!CODE_RE.test(code)) {
      throw new ApiError('Camera code must be 1-32 characters (letters, numbers, - or _)', 400)
    }
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (name.length < 1 || name.length > 60) {
      throw new ApiError('Camera name must be between 1 and 60 characters', 400)
    }
    const streamUrl = validateStreamUrl(body?.streamUrl)

    let floorPlanId: number | null = null
    if (body?.floorPlanId != null) {
      const fpId = Number(body.floorPlanId)
      if (!Number.isInteger(fpId)) throw new ApiError('floorPlanId must be a numeric id', 400)
      const plan = await db.floorPlan.findUnique({ where: { id: fpId } })
      if (!plan || !plan.active) throw new ApiError('Floor plan not found or inactive', 400)
      floorPlanId = plan.id
    }

    const existing = await db.visionCamera.findUnique({ where: { code } })
    if (existing) throw new ApiError('Camera code already exists', 409)

    const camera = await db.visionCamera.create({
      data: { code, name, streamUrl, floorPlanId, status: 'offline' },
      include: CAMERA_LIST_INCLUDE,
    })
    await logAudit({
      user,
      action: 'vision.cameraCreate',
      entity: 'vision',
      entityId: camera.id,
      // NOTE: the stream URL is never written to the audit log
      details: `Camera ${camera.code} "${camera.name}" created${floorPlanId ? ` (floor plan ${camera.floorPlan?.name ?? floorPlanId})` : ''}`,
    })
    return NextResponse.json({ camera: serializeCamera(camera) }, { status: 201 })
  } catch (err) {
    return errorResponse(err)
  }
}
