// /api/vision/config — detection thresholds/timings + ingest key management
// (admin + 'vision' permission). GET returns the config with a MASKED ingest
// key; PUT accepts a partial config (+ optional rotateIngestKey) and returns
// the FULL key only when it was just rotated.

import { NextRequest, NextResponse } from 'next/server'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import {
  getOrCreateIngestKey,
  getVisionConfig,
  maskKey,
  rotateIngestKey,
  saveVisionConfig,
} from '@/lib/vision'
import type { VisionConfigDTO } from '@/lib/types'

const CONFIG_KEYS: (keyof VisionConfigDTO)[] = [
  'highConfidence',
  'mediumConfidence',
  'vacancyDelaySeconds',
  'movementDedupeMinutes',
  'movementCooldownMinutes',
  'serviceDelayMinutes',
  'maxEventAgeSeconds',
  'manualHoldMinutes',
]

const INGEST_ENDPOINT = '/api/vision/events'

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['vision'])
    const [config, key] = await Promise.all([getVisionConfig(), getOrCreateIngestKey()])
    return NextResponse.json({
      config,
      ingest: { key: maskKey(key), endpoint: INGEST_ENDPOINT },
    })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function PUT(req: NextRequest) {
  try {
    const user = await requireAuth(req, ['vision'])
    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })

    if (body?.rotateIngestKey !== undefined && typeof body.rotateIngestKey !== 'boolean') {
      throw new ApiError('rotateIngestKey must be a boolean', 400)
    }

    const partial: Partial<VisionConfigDTO> = {}
    const changedKeys: string[] = []
    const raw = partial as Record<string, unknown>
    for (const key of CONFIG_KEYS) {
      if (body?.[key] !== undefined) {
        raw[key] = body[key]
        changedKeys.push(key)
      }
    }

    const config = await saveVisionConfig(partial)

    let rotatedKey: string | null = null
    if (body?.rotateIngestKey === true) {
      rotatedKey = await rotateIngestKey()
      await logAudit({
        user,
        action: 'vision.ingestKeyRotate',
        entity: 'vision',
        entityId: null,
        details: 'Vision ingest key rotated (previous key invalidated)',
      })
    }
    if (changedKeys.length > 0) {
      await logAudit({
        user,
        action: 'vision.configUpdate',
        entity: 'vision',
        entityId: null,
        details: `Vision config updated: ${changedKeys.join(', ')}`,
      })
    }

    const key = rotatedKey ?? maskKey(await getOrCreateIngestKey())
    return NextResponse.json({
      config,
      ingest: { key, endpoint: INGEST_ENDPOINT },
    })
  } catch (err) {
    return errorResponse(err)
  }
}
