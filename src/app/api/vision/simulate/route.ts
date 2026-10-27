// /api/vision/simulate — EDGE SIMULATOR (admin + 'vision' permission).
// Emulates an edge vision processor by pushing events through the EXACT
// same ingestion pipeline (ingestVisionEvent) — this is how the feature is
// demonstrated without real CCTV hardware.
//
// Scenarios:
//   setup_demo               idempotent cameras (CAM-001/CAM-002) + a zone per
//                            active table of each camera's floor plan
//   seat { tableId, people?, confidence? }        OCCUPANCY OCCUPIED
//   vacate { tableId, confidence? }               OCCUPANCY EMPTY
//   walkby { tableId }                            low-confidence OCCUPIED (filtered)
//   move { fromTableId, toTableId, people?, confidence? }  MOVEMENT_DETECTED
//   camera_status { cameraId, status, error? }    CAMERA_STATUS
//   stale { tableId }                             30-minute-old occupancy (stale)

import { randomUUID } from 'crypto'
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { ingestVisionEvent } from '@/lib/vision'
import type { VisionIngestResult } from '@/lib/types'

const SIM_MODEL = 'rms-edge-sim'
const SIM_MODEL_VERSION = '1.0'

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function simEventId(): string {
  return 'sim-' + randomUUID()
}

function requireTableId(raw: unknown, label = 'tableId'): number {
  const id = Number(raw)
  if (!Number.isInteger(id)) throw new ApiError(`${label} must be a numeric id`, 400)
  return id
}

async function requireTable(raw: unknown, label = 'tableId') {
  const id = requireTableId(raw, label)
  const table = await db.restaurantTable.findUnique({ where: { id } })
  if (!table || !table.active) throw new ApiError('Table not found', 404)
  return table
}

async function requireZoneForTable(tableId: number, tableName: string) {
  const zone = await db.visionZone.findFirst({
    where: { tableId, active: true },
    include: { camera: true },
    orderBy: { id: 'asc' },
  })
  if (!zone) {
    throw new ApiError(
      `Table ${tableName} has no vision zone — run demo setup or configure zones first`,
      400,
    )
  }
  return zone
}

function validateConfidence(raw: unknown, fallback: number): number {
  if (raw == null) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0 || n > 1) {
    throw new ApiError('confidence must be a number in (0, 1]', 400)
  }
  return n
}

function validatePeople(raw: unknown, fallback: number, min: number, max: number): number {
  if (raw == null) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new ApiError(`people must be an integer between ${min} and ${max}`, 400)
  }
  return n
}

async function logSim(
  user: { userId: number; name: string; personId: number | null; personName: string | null },
  details: string,
) {
  await logAudit({ user, action: 'vision.simulate', entity: 'vision', entityId: null, details })
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireAuth(req, ['vision'])
    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })
    const scenario = typeof body?.scenario === 'string' ? body.scenario : ''

    if (scenario === 'setup_demo') {
      // ── idempotent demo environment: cameras + one zone per table ──
      const fp1 =
        (await db.floorPlan.findUnique({ where: { id: 1 } })) ??
        (await db.floorPlan.findFirst({ where: { active: true } }))
      if (!fp1) throw new ApiError('No floor plans found — create one first', 400)
      const fp2 = (await db.floorPlan.findUnique({ where: { id: 2 } })) ?? fp1

      const specs = [
        { code: 'CAM-001', name: 'Main Hall Cam', floorPlanId: fp1.id },
        { code: 'CAM-002', name: 'Terrace Cam', floorPlanId: fp2.id },
      ]
      const cameras: { id: number; code: string }[] = []
      let zonesCreated = 0
      for (const spec of specs) {
        const camera = await db.visionCamera.upsert({
          where: { code: spec.code },
          update: {},
          create: {
            code: spec.code,
            name: spec.name,
            floorPlanId: spec.floorPlanId,
            status: 'offline',
          },
        })
        cameras.push(camera)
        if (camera.floorPlanId == null) continue
        const tables = await db.restaurantTable.findMany({
          where: { floorPlanId: camera.floorPlanId, active: true },
        })
        for (const table of tables) {
          const zoneName = `Z-${table.name}`
          const existing = await db.visionZone.findFirst({ where: { name: zoneName } })
          if (existing) continue
          // axis-aligned box around the table position (±6 percentage points)
          const cx = clamp01(table.positionX / 100)
          const cy = clamp01(table.positionY / 100)
          const half = 0.06
          const polygon = [
            { x: clamp01(cx - half), y: clamp01(cy - half) },
            { x: clamp01(cx + half), y: clamp01(cy - half) },
            { x: clamp01(cx + half), y: clamp01(cy + half) },
            { x: clamp01(cx - half), y: clamp01(cy + half) },
          ]
          await db.visionZone.create({
            data: {
              cameraId: camera.id,
              name: zoneName,
              kind: 'table',
              tableId: table.id,
              polygon: JSON.stringify(polygon),
              seats: table.capacity,
              createdBy: user.name,
            },
          })
          zonesCreated += 1
        }
      }

      // bring the cameras online through the REAL ingest pipeline
      const results: VisionIngestResult[] = []
      for (const camera of cameras) {
        const event = {
          event_id: simEventId(),
          event_type: 'CAMERA_STATUS',
          camera_id: camera.code,
          event_time: new Date().toISOString(),
          status: 'online',
          model: SIM_MODEL,
          model_version: SIM_MODEL_VERSION,
        }
        results.push(await ingestVisionEvent(event, 'simulator'))
      }
      const summary = `demo setup: ${zonesCreated} zone(s) created, ${cameras.length} cameras ensured`
      for (const result of results) {
        result.detail = result.detail ? `${result.detail} — ${summary}` : summary
      }
      await logSim(user, 'Demo setup: cameras + zones')
      return NextResponse.json({ results })
    }

    if (scenario === 'seat' || scenario === 'vacate' || scenario === 'stale') {
      const table = await requireTable(body?.tableId)
      const zone = await requireZoneForTable(table.id, table.name)
      const isStale = scenario === 'stale'
      const eventTime = isStale
        ? new Date(Date.now() - 30 * 60_000).toISOString() // 30 minutes old → stale
        : new Date().toISOString()
      const confidence = isStale
        ? 0.9
        : scenario === 'seat'
          ? validateConfidence(body?.confidence, 0.95)
          : validateConfidence(body?.confidence, 0.93)
      const people = isStale ? 2 : scenario === 'seat' ? validatePeople(body?.people, 2, 1, 20) : 0
      const event = {
        event_id: simEventId(),
        event_type: 'OCCUPANCY_CHANGED',
        camera_id: zone.camera.code,
        event_time: eventTime,
        confidence,
        occupancy_state: isStale || scenario === 'seat' ? 'OCCUPIED' : 'EMPTY',
        people_count: people,
        zone_id: zone.id,
        model: SIM_MODEL,
        model_version: SIM_MODEL_VERSION,
      }
      const result = await ingestVisionEvent(event, 'simulator')
      await logSim(
        user,
        `Simulated ${scenario}: table ${table.name}${isStale ? ' (30-min-old event)' : ''}`,
      )
      return NextResponse.json({ results: [result] })
    }

    if (scenario === 'walkby') {
      const table = await requireTable(body?.tableId)
      const zone = await requireZoneForTable(table.id, table.name)
      // low-confidence detection — demonstrates confidence filtering
      const event = {
        event_id: simEventId(),
        event_type: 'OCCUPANCY_CHANGED',
        camera_id: zone.camera.code,
        event_time: new Date().toISOString(),
        confidence: 0.35,
        occupancy_state: 'OCCUPIED',
        people_count: 1,
        zone_id: zone.id,
        model: SIM_MODEL,
        model_version: SIM_MODEL_VERSION,
      }
      const result = await ingestVisionEvent(event, 'simulator')
      await logSim(user, `Simulated walkby: table ${table.name} (low confidence)`)
      return NextResponse.json({ results: [result] })
    }

    if (scenario === 'move') {
      const fromTable = await requireTable(body?.fromTableId, 'fromTableId')
      const toTable = await requireTable(body?.toTableId, 'toTableId')
      const fromZone = await requireZoneForTable(fromTable.id, fromTable.name)
      await requireZoneForTable(toTable.id, toTable.name)
      const people = validatePeople(body?.people, 3, 1, 20)
      const confidence = validateConfidence(body?.confidence, 0.92)
      const event = {
        event_id: simEventId(),
        event_type: 'MOVEMENT_DETECTED',
        camera_id: fromZone.camera.code,
        event_time: new Date().toISOString(),
        confidence,
        from_table_id: fromTable.id,
        to_table_id: toTable.id,
        people_count: people,
        model: SIM_MODEL,
        model_version: SIM_MODEL_VERSION,
      }
      const result = await ingestVisionEvent(event, 'simulator')
      await logSim(
        user,
        `Simulated move: ${fromTable.name} → ${toTable.name} (${people} guests)`,
      )
      return NextResponse.json({ results: [result] })
    }

    if (scenario === 'camera_status') {
      const raw = body?.cameraId
      const camera =
        typeof raw === 'string'
          ? await db.visionCamera.findUnique({ where: { code: raw } })
          : await db.visionCamera.findUnique({ where: { id: requireTableId(raw, 'cameraId') } })
      if (!camera) throw new ApiError('Camera not found', 404)
      const status = body?.status
      if (status !== 'online' && status !== 'offline' && status !== 'error') {
        throw new ApiError("status must be 'online', 'offline' or 'error'", 400)
      }
      let cameraError: string | undefined
      if (body?.error != null) {
        if (typeof body.error !== 'string' || body.error.length > 200) {
          throw new ApiError('error must be a string of at most 200 characters', 400)
        }
        cameraError = body.error
      }
      const event = {
        event_id: simEventId(),
        event_type: 'CAMERA_STATUS',
        camera_id: camera.code,
        event_time: new Date().toISOString(),
        status,
        ...(cameraError != null ? { error: cameraError } : {}),
        model: SIM_MODEL,
        model_version: SIM_MODEL_VERSION,
      }
      const result = await ingestVisionEvent(event, 'simulator')
      await logSim(user, `Simulated camera_status: ${camera.code} → ${status}`)
      return NextResponse.json({ results: [result] })
    }

    throw new ApiError(`Unknown simulation scenario "${scenario || '(missing)'}"`, 400)
  } catch (err) {
    return errorResponse(err)
  }
}
