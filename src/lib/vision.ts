// ─── R9: AI vision / CCTV seating intelligence — engine ──────────────
// The whole vision subsystem lives here: config (AppSetting KV), the edge
// ingest pipeline, read-time effective-state resolution, HUMAN-confirmed
// movement decisions, manual overrides, serializers and the overview /
// analytics builders.
//
// ARCHITECTURE (non-negotiable):
// - Vision is a PARALLEL OBSERVATIONAL layer. Edge vision processors send
//   STRUCTURED events (never raw video).
// - AI state lives in VisionTableState and is SEPARATE from operational
//   `tables.status`. This module NEVER writes `tables.status` EXCEPT inside
//   the human-confirmed movement flow, which reuses the exact POS transfer
//   semantics (lib/orders.rehouseOpenOrder).
// - Camera failure → vision state 'unknown' (never 'empty').
// - Every AI-suggested movement requires human confirm/reject.

import { randomBytes, randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import type { VisionEvent, VisionTableState } from '@prisma/client'
import { db } from '@/lib/db'
import { ApiError, type SessionPayload } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import {
  VISION_CONFIG_KEY,
  VISION_DEFAULT_CONFIG,
  VISION_EVENT_TYPES,
  VISION_INGEST_KEY,
  VISION_INGEST_MAX_EVENTS,
  VISION_ZONE_KINDS,
} from '@/lib/constants'
import {
  ORDER_INCLUDE,
  findOpenOrderOnTable,
  rehouseOpenOrder,
  round2,
  serializeFloorPlans,
  serializeOrder,
} from '@/lib/orders'
import type {
  MovementCandidateDTO,
  MovementEvidence,
  Order,
  VisionAlertDTO,
  VisionAnalyticsDTO,
  VisionCameraDTO,
  VisionConfigDTO,
  VisionEventDTO,
  VisionEventOutcome,
  VisionFloorDTO,
  VisionFloorTableDTO,
  VisionIngestResult,
  VisionOverviewDTO,
  VisionTableStateDTO,
  VisionZoneDTO,
  VisionZonePoint,
} from '@/lib/types'

// ─── Row types (Prisma payloads) ─────────────────────────────────────

export type VisionCameraRow = Prisma.VisionCameraGetPayload<{
  include: { _count: { select: { zones: true } }; floorPlan: { select: { name: true } } }
}>

export type VisionZoneRow = Prisma.VisionZoneGetPayload<{
  include: {
    camera: { select: { code: true; floorPlanId: true } }
    table: { select: { name: true; floorPlanId: true } }
  }
}>

export type VisionTableStateRow = VisionTableState

export const MOVEMENT_INCLUDE = {
  fromTable: { select: { id: true, name: true, status: true, active: true } },
  toTable: { select: { id: true, name: true, status: true, active: true } },
} satisfies Prisma.MovementCandidateInclude

export type MovementRow = Prisma.MovementCandidateGetPayload<{
  include: typeof MOVEMENT_INCLUDE
}>

/** Minimal order projection used by movement serializers. */
export type MovementOrderInfo = {
  id: number
  status: string
  tableId: number | null
  totalAmount: number
}

// ─── Config & ingest key (AppSetting KV) ─────────────────────────────

function asNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? n : fallback
}

function asIntAtLeast1(value: unknown, fallback: number): number {
  const n = Math.round(asNumber(value, fallback))
  return Number.isFinite(n) && n >= 1 ? n : fallback
}

/** Clamp a confidence-ish number into (0, 1]. */
function asConfidence(value: unknown, fallback: number): number {
  const n = asNumber(value, fallback)
  return Math.min(1, Math.max(0.01, n))
}

/** Merge a raw JSON value over the defaults with tolerant sanitization. */
function sanitizeVisionConfig(raw: Record<string, unknown>): VisionConfigDTO {
  let highConfidence = asConfidence(raw.highConfidence, VISION_DEFAULT_CONFIG.highConfidence)
  let mediumConfidence = asConfidence(raw.mediumConfidence, VISION_DEFAULT_CONFIG.mediumConfidence)
  if (!(mediumConfidence < highConfidence)) {
    // unusable pair — fall back to the shipped defaults
    highConfidence = VISION_DEFAULT_CONFIG.highConfidence
    mediumConfidence = VISION_DEFAULT_CONFIG.mediumConfidence
  }
  return {
    highConfidence,
    mediumConfidence,
    vacancyDelaySeconds: asIntAtLeast1(raw.vacancyDelaySeconds, VISION_DEFAULT_CONFIG.vacancyDelaySeconds),
    movementDedupeMinutes: asIntAtLeast1(raw.movementDedupeMinutes, VISION_DEFAULT_CONFIG.movementDedupeMinutes),
    movementCooldownMinutes: asIntAtLeast1(raw.movementCooldownMinutes, VISION_DEFAULT_CONFIG.movementCooldownMinutes),
    serviceDelayMinutes: asIntAtLeast1(raw.serviceDelayMinutes, VISION_DEFAULT_CONFIG.serviceDelayMinutes),
    maxEventAgeSeconds: asIntAtLeast1(raw.maxEventAgeSeconds, VISION_DEFAULT_CONFIG.maxEventAgeSeconds),
    manualHoldMinutes: asIntAtLeast1(raw.manualHoldMinutes, VISION_DEFAULT_CONFIG.manualHoldMinutes),
  }
}

async function readRawConfig(): Promise<Record<string, unknown>> {
  const row = await db.appSetting.findUnique({ where: { key: VISION_CONFIG_KEY } })
  if (!row?.value) return {}
  try {
    const parsed: unknown = JSON.parse(row.value)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // corrupted JSON — fall through to defaults
  }
  return {}
}

/** Read the vision config (merged over defaults, sanitized). */
export async function getVisionConfig(): Promise<VisionConfigDTO> {
  return sanitizeVisionConfig(await readRawConfig())
}

const CONFIG_INT_KEYS = [
  'vacancyDelaySeconds',
  'movementDedupeMinutes',
  'movementCooldownMinutes',
  'serviceDelayMinutes',
  'maxEventAgeSeconds',
  'manualHoldMinutes',
] as const

/** Validate + persist a partial config update; returns the merged config. */
export async function saveVisionConfig(partial: Partial<VisionConfigDTO>): Promise<VisionConfigDTO> {
  const current = await getVisionConfig()
  const next: Record<string, number> = { ...current }

  if (partial.highConfidence !== undefined) {
    const n = Number(partial.highConfidence)
    if (!Number.isFinite(n) || n <= 0 || n > 1) {
      throw new ApiError('highConfidence must be a number in (0, 1]', 400)
    }
    next.highConfidence = n
  }
  if (partial.mediumConfidence !== undefined) {
    const n = Number(partial.mediumConfidence)
    if (!Number.isFinite(n) || n <= 0 || n > 1) {
      throw new ApiError('mediumConfidence must be a number in (0, 1]', 400)
    }
    next.mediumConfidence = n
  }
  for (const key of CONFIG_INT_KEYS) {
    const value = partial[key]
    if (value === undefined) continue
    const n = Number(value)
    if (!Number.isInteger(n) || n < 1) {
      throw new ApiError(`${key} must be an integer ≥ 1`, 400)
    }
    next[key] = n
  }
  if (!(next.mediumConfidence < next.highConfidence)) {
    throw new ApiError('mediumConfidence must be lower than highConfidence', 400)
  }

  const merged = sanitizeVisionConfig(next)
  await db.appSetting.upsert({
    where: { key: VISION_CONFIG_KEY },
    update: { value: JSON.stringify(merged) },
    create: { key: VISION_CONFIG_KEY, value: JSON.stringify(merged) },
  })
  return merged
}

function generateIngestKey(): string {
  return 'rms-vision-' + randomBytes(16).toString('hex') // 32 hex chars
}

/** Read (or lazily create) the edge ingest key stored in AppSetting. */
export async function getOrCreateIngestKey(): Promise<string> {
  const row = await db.appSetting.findUnique({ where: { key: VISION_INGEST_KEY } })
  if (row?.value && row.value.length > 0) return row.value
  const key = generateIngestKey()
  await db.appSetting.upsert({
    where: { key: VISION_INGEST_KEY },
    update: { value: key },
    create: { key: VISION_INGEST_KEY, value: key },
  })
  return key
}

/** Generate + store a fresh ingest key (the old key stops working). */
export async function rotateIngestKey(): Promise<string> {
  const key = generateIngestKey()
  await db.appSetting.upsert({
    where: { key: VISION_INGEST_KEY },
    update: { value: key },
    create: { key: VISION_INGEST_KEY, value: key },
  })
  return key
}

/** Mask an ingest key for display (first 12 chars + ellipsis). */
export function maskKey(key: string): string {
  return key.length <= 12 ? key : key.slice(0, 12) + '…'
}

/** Strip any embedded userinfo defensively and truncate for display. */
export function maskStreamUrl(url: string | null): string | null {
  if (url == null || url === '') return null
  const stripped = url.replace(/^([A-Za-z0-9+.-]+):\/\/[^@/?#]+@/, '$1://')
  return stripped.length > 80 ? stripped.slice(0, 80) + '…' : stripped
}

// ─── Event validation ────────────────────────────────────────────────

/** Tolerant numeric-id coercion: accepts 12 and "12", rejects garbage. */
function coerceId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value.trim())
    if (Number.isInteger(n)) return n
  }
  return null
}

export type ParsedVisionEvent = {
  eventId: string
  eventType: string
  cameraCode: string
  detectedAt: Date
  confidence: number | null
  occupancyState: 'OCCUPIED' | 'EMPTY' | null
  peopleCount: number | null
  zoneId: number | null
  tableId: number | null
  fromTableId: number | null
  toTableId: number | null
  cameraStatus: 'online' | 'offline' | 'error' | null
  cameraError: string | null
  model: string | null
  modelVersion: string | null
}

export type VisionEventValidation =
  | { ok: true; event: ParsedVisionEvent }
  | { ok: false; error: string }

/**
 * Strict validation of one structured edge event. Unknown extra fields are
 * ignored (the raw payload is still stored for audit/evidence).
 */
export function validateVisionEvent(raw: unknown): VisionEventValidation {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'event must be a JSON object' }
  }
  const obj = raw as Record<string, unknown>

  if (typeof obj.event_id !== 'string' || obj.event_id.length < 1 || obj.event_id.length > 64) {
    return { ok: false, error: 'event_id must be a string of 1..64 characters' }
  }
  if (
    typeof obj.event_type !== 'string' ||
    !(VISION_EVENT_TYPES as readonly string[]).includes(obj.event_type)
  ) {
    return { ok: false, error: `event_type must be one of: ${VISION_EVENT_TYPES.join(', ')}` }
  }
  if (typeof obj.camera_id !== 'string' || obj.camera_id.length < 1 || obj.camera_id.length > 64) {
    return { ok: false, error: 'camera_id must be a string of 1..64 characters' }
  }
  if (typeof obj.event_time !== 'string') {
    return { ok: false, error: 'event_time is required (ISO datetime string)' }
  }
  const detectedAt = new Date(obj.event_time)
  if (Number.isNaN(detectedAt.getTime())) {
    return { ok: false, error: 'event_time is not a valid datetime' }
  }

  let confidence: number | null = null
  if (obj.confidence != null) {
    const n = Number(obj.confidence)
    if (typeof obj.confidence !== 'number' || !Number.isFinite(n) || n < 0 || n > 1) {
      return { ok: false, error: 'confidence must be a number between 0 and 1' }
    }
    confidence = n
  }
  const eventType: string = obj.event_type
  if (
    (eventType === 'OCCUPANCY_CHANGED' || eventType === 'MOVEMENT_DETECTED') &&
    confidence == null
  ) {
    return { ok: false, error: `confidence is required for ${eventType}` }
  }

  let model: string | null = null
  if (obj.model != null) {
    if (typeof obj.model !== 'string' || obj.model.length > 60) {
      return { ok: false, error: 'model must be a string of at most 60 characters' }
    }
    model = obj.model
  }
  let modelVersion: string | null = null
  if (obj.model_version != null) {
    if (typeof obj.model_version !== 'string' || obj.model_version.length > 40) {
      return { ok: false, error: 'model_version must be a string of at most 40 characters' }
    }
    modelVersion = obj.model_version
  }

  const base = {
    eventId: obj.event_id,
    eventType,
    cameraCode: obj.camera_id,
    detectedAt,
    confidence,
    model,
    modelVersion,
  }

  if (eventType === 'CAMERA_STATUS') {
    if (obj.status !== 'online' && obj.status !== 'offline' && obj.status !== 'error') {
      return { ok: false, error: "status must be 'online', 'offline' or 'error'" }
    }
    if (obj.error != null && (typeof obj.error !== 'string' || obj.error.length > 200)) {
      return { ok: false, error: 'error must be a string of at most 200 characters' }
    }
    const event: ParsedVisionEvent = {
      ...base,
      occupancyState: null,
      peopleCount: null,
      zoneId: null,
      tableId: null,
      fromTableId: null,
      toTableId: null,
      cameraStatus: obj.status,
      cameraError: typeof obj.error === 'string' ? obj.error : null,
    }
    return { ok: true, event }
  }

  if (eventType === 'OCCUPANCY_CHANGED') {
    if (obj.occupancy_state !== 'OCCUPIED' && obj.occupancy_state !== 'EMPTY') {
      return { ok: false, error: "occupancy_state must be 'OCCUPIED' or 'EMPTY'" }
    }
    const peopleCount = Number(obj.people_count)
    if (!Number.isInteger(peopleCount) || peopleCount < 0 || peopleCount > 50) {
      return { ok: false, error: 'people_count must be an integer between 0 and 50' }
    }
    let zoneId: number | null = null
    if (obj.zone_id != null) {
      const z = coerceId(obj.zone_id)
      if (z == null) return { ok: false, error: 'zone_id must be a numeric id' }
      zoneId = z
    }
    let tableId: number | null = null
    if (obj.table_id != null) {
      const t = coerceId(obj.table_id)
      if (t == null) return { ok: false, error: 'table_id must be a numeric id' }
      tableId = t
    }
    const event: ParsedVisionEvent = {
      ...base,
      occupancyState: obj.occupancy_state,
      peopleCount,
      zoneId,
      tableId,
      fromTableId: null,
      toTableId: null,
      cameraStatus: null,
      cameraError: null,
    }
    return { ok: true, event }
  }

  // MOVEMENT_DETECTED
  const fromTableId = coerceId(obj.from_table_id)
  if (fromTableId == null) return { ok: false, error: 'from_table_id must be a numeric id' }
  const toTableId = coerceId(obj.to_table_id)
  if (toTableId == null) return { ok: false, error: 'to_table_id must be a numeric id' }
  if (fromTableId === toTableId) {
    return { ok: false, error: 'from_table_id and to_table_id must differ' }
  }
  const peopleCount = Number(obj.people_count)
  if (!Number.isInteger(peopleCount) || peopleCount < 1 || peopleCount > 50) {
    return { ok: false, error: 'people_count must be an integer between 1 and 50' }
  }
  const event: ParsedVisionEvent = {
    ...base,
    occupancyState: null,
    peopleCount,
    zoneId: null,
    tableId: fromTableId,
    fromTableId,
    toTableId,
    cameraStatus: null,
    cameraError: null,
  }
  return { ok: true, event }
}

// ─── Event persistence helper ────────────────────────────────────────

function safeJson(value: unknown): string | null {
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  )
}

type EventRecordInput = {
  eventId: string
  type: string
  cameraCode: string
  cameraId: number | null
  zoneId: number | null
  tableId: number | null
  peopleCount: number | null
  confidence: number | null
  detectedAt: Date
  outcome: VisionEventOutcome
  outcomeDetail: string | null
  model: string | null
  modelVersion: string | null
  payload: string | null
}

/** Persist the VisionEvent row and build the ingest result for it. */
async function recordVisionEvent(input: EventRecordInput): Promise<VisionIngestResult> {
  try {
    await db.visionEvent.create({
      data: {
        eventId: input.eventId,
        type: input.type,
        cameraCode: input.cameraCode,
        cameraId: input.cameraId,
        zoneId: input.zoneId,
        tableId: input.tableId,
        peopleCount: input.peopleCount,
        confidence: input.confidence,
        detectedAt: input.detectedAt,
        outcome: input.outcome,
        outcomeDetail: input.outcomeDetail,
        payload: input.payload,
        model: input.model,
        modelVersion: input.modelVersion,
      },
    })
  } catch (err) {
    if (isUniqueViolation(err)) {
      // eventId already recorded — concurrent duplicate
      return { event_id: input.eventId, outcome: 'duplicate', detail: null }
    }
    throw err
  }
  return { event_id: input.eventId, outcome: input.outcome, detail: input.outcomeDetail }
}

/** Best-effort extraction of a usable event_id from an invalid payload. */
function extractEventId(raw: unknown): string | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = (raw as Record<string, unknown>).event_id
  return typeof id === 'string' && id.length >= 1 && id.length <= 64 ? id : null
}

function extractEventTime(raw: unknown): Date | null {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const t = (raw as Record<string, unknown>).event_time
  if (typeof t !== 'string') return null
  const d = new Date(t)
  return Number.isNaN(d.getTime()) ? null : d
}

// ─── Ingest pipeline ─────────────────────────────────────────────────

/** Ensure a VisionTableState row exists (created 'unknown') and return it. */
async function ensureTableState(tableId: number): Promise<VisionTableStateRow> {
  return db.visionTableState.upsert({
    where: { tableId },
    update: {},
    create: { tableId, state: 'unknown', peopleCount: 0, confidence: 0, stateSince: new Date() },
  })
}

function parseEvidence(raw: string | null): MovementEvidence {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const obj = parsed as Record<string, unknown>
    if (!Array.isArray(obj.eventIds)) return null
    return {
      cameraCode: typeof obj.cameraCode === 'string' ? obj.cameraCode : null,
      eventIds: obj.eventIds.map(String),
      peopleCount: Number(obj.peopleCount) || 0,
      confidence: Number(obj.confidence) || 0,
    }
  } catch {
    return null
  }
}

/**
 * Ingest ONE structured event. NEVER throws for bad events — every outcome
 * (including rejections) is returned as a VisionIngestResult and, whenever
 * the event_id is parseable, recorded as a VisionEvent row.
 */
export async function ingestVisionEvent(
  raw: unknown,
  source: 'edge' | 'simulator' | 'session',
): Promise<VisionIngestResult> {
  // 1. Validate
  const validated = validateVisionEvent(raw)
  if (!validated.ok) {
    const eventId = extractEventId(raw)
    if (eventId == null) {
      return { event_id: '(invalid)', outcome: 'rejected', detail: validated.error }
    }
    const obj = raw as Record<string, unknown>
    const cameraCode = typeof obj.camera_id === 'string' ? obj.camera_id : '(unknown)'
    const type = typeof obj.event_type === 'string' ? obj.event_type : '(invalid)'
    return recordVisionEvent({
      eventId,
      type,
      cameraCode,
      cameraId: null,
      zoneId: null,
      tableId: null,
      peopleCount: null,
      confidence: null,
      detectedAt: extractEventTime(raw) ?? new Date(),
      outcome: 'rejected',
      outcomeDetail: validated.error,
      model: null,
      modelVersion: null,
      payload: safeJson(raw),
    })
  }
  const event = validated.event
  const payload = safeJson(raw)

  const baseRecord = (overrides: {
    outcome: VisionEventOutcome
    outcomeDetail?: string | null
    cameraId?: number | null
    zoneId?: number | null
    tableId?: number | null
    peopleCount?: number | null
    confidence?: number | null
  }): EventRecordInput => ({
    eventId: event.eventId,
    type: event.eventType,
    cameraCode: event.cameraCode,
    cameraId: overrides.cameraId ?? null,
    zoneId: overrides.zoneId ?? null,
    tableId: overrides.tableId ?? null,
    peopleCount: overrides.peopleCount ?? event.peopleCount,
    confidence: overrides.confidence !== undefined ? overrides.confidence : event.confidence,
    detectedAt: event.detectedAt,
    outcome: overrides.outcome,
    outcomeDetail: overrides.outcomeDetail ?? null,
    model: event.model,
    modelVersion: event.modelVersion,
    payload,
  })

  // 2. Idempotency (edge-generated event_id)
  const existing = await db.visionEvent.findUnique({
    where: { eventId: event.eventId },
    select: { id: true },
  })
  if (existing) {
    return { event_id: event.eventId, outcome: 'duplicate', detail: null }
  }

  // 3. Camera lookup (by code, active)
  const camera = await db.visionCamera.findUnique({ where: { code: event.cameraCode } })
  if (!camera || !camera.active) {
    return recordVisionEvent(
      baseRecord({
        outcome: 'unknown_camera',
        outcomeDetail: `camera ${event.cameraCode} is not registered or inactive`,
      }),
    )
  }

  // 4. Stale events are never replayed blindly
  const config = await getVisionConfig()
  const now = new Date()
  const ageMs = now.getTime() - event.detectedAt.getTime()
  if (ageMs > config.maxEventAgeSeconds * 1000) {
    return recordVisionEvent(
      baseRecord({
        outcome: 'stale',
        outcomeDetail: `event older than maxEventAgeSeconds (${config.maxEventAgeSeconds}s)`,
        cameraId: camera.id,
      }),
    )
  }

  // 5. Per-type processing
  if (event.eventType === 'CAMERA_STATUS') {
    const nextStatus = event.cameraStatus ?? 'offline'
    const lastSeenAt =
      camera.lastSeenAt && camera.lastSeenAt > event.detectedAt ? camera.lastSeenAt : event.detectedAt
    await db.visionCamera.update({
      where: { id: camera.id },
      data: { status: nextStatus, lastSeenAt, lastError: event.cameraError ?? null },
    })
    // Camera failure → every mapped table's vision state degrades to
    // 'unknown' (NEVER 'empty'). peopleCount/confidence keep the last-known
    // values so the floor still shows the last credible observation.
    if (nextStatus === 'offline' || nextStatus === 'error') {
      const zones = await db.visionZone.findMany({
        where: { cameraId: camera.id, active: true, tableId: { not: null } },
        select: { tableId: true },
      })
      for (const zone of zones) {
        if (zone.tableId == null) continue
        await db.visionTableState.upsert({
          where: { tableId: zone.tableId },
          update: { state: 'unknown', stateSince: now, pendingEmptySince: null },
          create: { tableId: zone.tableId, state: 'unknown', stateSince: now, pendingEmptySince: null },
        })
      }
    }
    return recordVisionEvent(
      baseRecord({
        outcome: 'applied',
        outcomeDetail: `camera ${camera.code} → ${nextStatus}`,
        cameraId: camera.id,
        confidence: event.confidence,
        peopleCount: null,
      }),
    )
  }

  if (event.eventType === 'OCCUPANCY_CHANGED') {
    // Resolve zone (when the event carries a zone_id)
    let zone: { id: number; tableId: number | null } | null = null
    if (event.zoneId != null) {
      const found = await db.visionZone.findUnique({ where: { id: event.zoneId } })
      if (!found || !found.active || found.cameraId !== camera.id) {
        return recordVisionEvent(
          baseRecord({
            outcome: 'unknown_zone',
            outcomeDetail: `zone ${event.zoneId} not found on camera ${camera.code}`,
            cameraId: camera.id,
            zoneId: event.zoneId,
          }),
        )
      }
      zone = { id: found.id, tableId: found.tableId }
    }

    // Resolve the table (table_id override, else the zone's mapping)
    let tableId: number | null = null
    if (event.tableId != null) {
      const table = await db.restaurantTable.findUnique({ where: { id: event.tableId } })
      if (!table || !table.active) {
        return recordVisionEvent(
          baseRecord({
            outcome: 'rejected',
            outcomeDetail: `table ${event.tableId} not found or inactive`,
            cameraId: camera.id,
            zoneId: zone?.id ?? null,
          }),
        )
      }
      tableId = table.id
    } else if (zone?.tableId != null) {
      tableId = zone.tableId
    } else {
      return recordVisionEvent(
        baseRecord({
          outcome: 'rejected',
          outcomeDetail: 'zone not mapped to a table',
          cameraId: camera.id,
          zoneId: zone?.id ?? null,
        }),
      )
    }

    const current = await ensureTableState(tableId)

    // Out-of-order guard: never regress state with older observations
    if (current.lastEventAt && event.detectedAt < current.lastEventAt) {
      return recordVisionEvent(
        baseRecord({
          outcome: 'out_of_order',
          outcomeDetail: 'older than the last processed event for this table',
          cameraId: camera.id,
          zoneId: zone?.id ?? null,
          tableId,
        }),
      )
    }

    // Manual hold: record the event, hold the display state
    if (current.manualHoldUntil && current.manualHoldUntil > now) {
      await db.visionTableState.update({
        where: { tableId },
        data: { lastEventAt: event.detectedAt },
      })
      return recordVisionEvent(
        baseRecord({
          outcome: 'applied',
          outcomeDetail: 'manual hold active — display state held',
          cameraId: camera.id,
          zoneId: zone?.id ?? null,
          tableId,
        }),
      )
    }

    // Low confidence: recorded only — never changes observational state
    if (event.confidence != null && event.confidence < config.mediumConfidence) {
      await db.visionTableState.update({
        where: { tableId },
        data: { lastEventAt: event.detectedAt },
      })
      return recordVisionEvent(
        baseRecord({
          outcome: 'low_confidence',
          outcomeDetail: `confidence ${event.confidence} below mediumConfidence ${config.mediumConfidence}`,
          cameraId: camera.id,
          zoneId: zone?.id ?? null,
          tableId,
        }),
      )
    }

    if (event.occupancyState === 'OCCUPIED') {
      const stateChanged = current.state !== 'occupied'
      await db.visionTableState.update({
        where: { tableId },
        data: {
          state: 'occupied',
          peopleCount: event.peopleCount ?? 0,
          confidence: event.confidence ?? 0,
          stateSince: stateChanged ? event.detectedAt : current.stateSince,
          pendingEmptySince: null,
          lastEventAt: event.detectedAt,
        },
      })
      return recordVisionEvent(
        baseRecord({
          outcome: 'applied',
          cameraId: camera.id,
          zoneId: zone?.id ?? null,
          tableId,
        }),
      )
    }

    // EMPTY — vacancy debounce (sustained absence)
    if (current.state === 'empty') {
      // already vacant — refresh the observation timestamp only
      await db.visionTableState.update({
        where: { tableId },
        data: { lastEventAt: event.detectedAt },
      })
      return recordVisionEvent(
        baseRecord({
          outcome: 'applied',
          cameraId: camera.id,
          zoneId: zone?.id ?? null,
          tableId,
        }),
      )
    }
    const pending = current.pendingEmptySince ?? event.detectedAt
    const elapsedMs = event.detectedAt.getTime() - pending.getTime()
    if (elapsedMs >= config.vacancyDelaySeconds * 1000) {
      // sustained absence confirmed → vacant
      await db.visionTableState.update({
        where: { tableId },
        data: {
          state: 'empty',
          peopleCount: 0,
          confidence: event.confidence ?? 0,
          stateSince: event.detectedAt,
          pendingEmptySince: null,
          lastEventAt: event.detectedAt,
        },
      })
      return recordVisionEvent(
        baseRecord({
          outcome: 'applied',
          cameraId: camera.id,
          zoneId: zone?.id ?? null,
          tableId,
        }),
      )
    }
    // grace window — keep the current state while absence is not sustained
    await db.visionTableState.update({
      where: { tableId },
      data: { pendingEmptySince: pending, lastEventAt: event.detectedAt },
    })
    return recordVisionEvent(
      baseRecord({
        outcome: 'applied',
        outcomeDetail:
          current.state === 'occupied' ? 'vacancy grace — awaiting sustained absence' : null,
        cameraId: camera.id,
        zoneId: zone?.id ?? null,
        tableId,
      }),
    )
  }

  // MOVEMENT_DETECTED — propose a candidate, NEVER apply it
  if (event.confidence != null && event.confidence < config.mediumConfidence) {
    return recordVisionEvent(
      baseRecord({
        outcome: 'low_confidence',
        outcomeDetail: `confidence ${event.confidence} below mediumConfidence ${config.mediumConfidence}`,
        cameraId: camera.id,
        tableId: event.fromTableId,
      }),
    )
  }
  const [fromTable, toTable] = await Promise.all([
    db.restaurantTable.findUnique({ where: { id: event.fromTableId! } }),
    db.restaurantTable.findUnique({ where: { id: event.toTableId! } }),
  ])
  if (!fromTable || !fromTable.active) {
    return recordVisionEvent(
      baseRecord({
        outcome: 'rejected',
        outcomeDetail: `source table ${event.fromTableId} not found or inactive`,
        cameraId: camera.id,
      }),
    )
  }
  if (!toTable || !toTable.active) {
    return recordVisionEvent(
      baseRecord({
        outcome: 'rejected',
        outcomeDetail: `target table ${event.toTableId} not found or inactive`,
        cameraId: camera.id,
      }),
    )
  }

  const openOrder = await findOpenOrderOnTable(fromTable.id)
  const orderId = openOrder?.id ?? null

  // Dedupe: a recent pending candidate for the same (from, to, order) merges
  const dedupeCutoff = new Date(now.getTime() - config.movementDedupeMinutes * 60_000)
  const pendingCandidate = await db.movementCandidate.findFirst({
    where: {
      fromTableId: fromTable.id,
      toTableId: toTable.id,
      orderId,
      status: 'pending',
      detectedAt: { gte: dedupeCutoff },
    },
    orderBy: { detectedAt: 'desc' },
  })
  if (pendingCandidate) {
    const evidence = parseEvidence(pendingCandidate.evidence)
    const mergedIds = [...(evidence?.eventIds ?? []), event.eventId]
      .filter((id, index, list) => list.indexOf(id) === index)
      .slice(-10)
    const peopleCount = event.peopleCount ?? pendingCandidate.peopleCount
    const confidence = event.confidence ?? pendingCandidate.confidence
    await db.movementCandidate.update({
      where: { id: pendingCandidate.id },
      data: {
        peopleCount,
        confidence,
        detectedAt:
          event.detectedAt > pendingCandidate.detectedAt ? event.detectedAt : pendingCandidate.detectedAt,
        evidence: JSON.stringify({
          cameraCode: camera.code,
          eventIds: mergedIds,
          peopleCount,
          confidence,
        }),
      },
    })
    return recordVisionEvent(
      baseRecord({
        outcome: 'applied',
        outcomeDetail: `merged into candidate #${pendingCandidate.id}`,
        cameraId: camera.id,
        tableId: fromTable.id,
      }),
    )
  }

  // Cooldown: a recent rejection for the same (from, to, order) suppresses
  const cooldownCutoff = new Date(now.getTime() - config.movementCooldownMinutes * 60_000)
  const rejectedRecent = await db.movementCandidate.findFirst({
    where: {
      fromTableId: fromTable.id,
      toTableId: toTable.id,
      orderId,
      status: 'rejected',
      decidedAt: { gte: cooldownCutoff },
    },
    orderBy: { decidedAt: 'desc' },
    select: { id: true },
  })
  if (rejectedRecent) {
    return recordVisionEvent(
      baseRecord({
        outcome: 'cooldown_suppressed',
        outcomeDetail: 'a recent rejection is still in its cooldown window',
        cameraId: camera.id,
        tableId: fromTable.id,
      }),
    )
  }

  const correlationKey = `${fromTable.id}:${toTable.id}:${orderId ?? 'none'}:${event.detectedAt.getTime()}`
  try {
    const created = await db.movementCandidate.create({
      data: {
        correlationKey,
        fromTableId: fromTable.id,
        toTableId: toTable.id,
        orderId,
        peopleCount: event.peopleCount ?? 0,
        confidence: event.confidence ?? 0,
        status: 'pending',
        detectedAt: event.detectedAt,
        evidence: JSON.stringify({
          cameraCode: camera.code,
          eventIds: [event.eventId],
          peopleCount: event.peopleCount ?? 0,
          confidence: event.confidence ?? 0,
        }),
      },
    })
    return recordVisionEvent(
      baseRecord({
        outcome: 'applied',
        outcomeDetail: `candidate #${created.id} created`,
        cameraId: camera.id,
        tableId: fromTable.id,
      }),
    )
  } catch (err) {
    if (isUniqueViolation(err)) {
      // same-millisecond duplicate detection — treat as a merge
      return recordVisionEvent(
        baseRecord({
          outcome: 'applied',
          outcomeDetail: 'duplicate detection merged',
          cameraId: camera.id,
          tableId: fromTable.id,
        }),
      )
    }
    throw err
  }
}

/**
 * Ingest a single event object OR `{ events: [...] }` (batch). Individual
 * bad events come back as 'rejected' results — never request failures.
 */
export async function ingestVisionEvents(
  body: unknown,
  source: 'edge' | 'simulator' | 'session',
): Promise<{ results: VisionIngestResult[] }> {
  let events: unknown[]
  if (
    body != null &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    Array.isArray((body as Record<string, unknown>).events)
  ) {
    const list = (body as Record<string, unknown>).events as unknown[]
    if (list.length > VISION_INGEST_MAX_EVENTS) {
      throw new ApiError(
        `Batch too large — at most ${VISION_INGEST_MAX_EVENTS} events per request`,
        400,
      )
    }
    events = list
  } else {
    events = [body]
  }
  const results: VisionIngestResult[] = []
  for (const event of events) {
    results.push(await ingestVisionEvent(event, source))
  }
  return { results }
}

// ─── Lazy vacancy resolution (read-time) ─────────────────────────────

export type EffectiveVisionState = {
  state: 'unknown' | 'empty' | 'occupied'
  peopleCount: number
  confidence: number
  stateSince: Date | null
  pendingEmptySince: Date | null
}

/**
 * Effective observational state at read time: a pending-empty window that
 * has fully elapsed resolves to 'empty' even before the next event lands
 * (single-node lazy evaluation — the overview builder persists it).
 */
export function resolveEffectiveVisionState(
  row: VisionTableStateRow,
  config: VisionConfigDTO,
  now: Date,
): EffectiveVisionState {
  if (
    row.state === 'occupied' &&
    row.pendingEmptySince != null &&
    now.getTime() - row.pendingEmptySince.getTime() >= config.vacancyDelaySeconds * 1000
  ) {
    return {
      state: 'empty',
      peopleCount: 0,
      confidence: row.confidence,
      stateSince: row.pendingEmptySince,
      pendingEmptySince: null,
    }
  }
  return {
    state: (row.state as 'unknown' | 'empty' | 'occupied') ?? 'unknown',
    peopleCount: row.peopleCount,
    confidence: row.confidence,
    stateSince: row.stateSince,
    pendingEmptySince: row.pendingEmptySince,
  }
}

// ─── Serializers ─────────────────────────────────────────────────────

export function serializeCamera(row: VisionCameraRow): VisionCameraDTO {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    streamUrl: maskStreamUrl(row.streamUrl),
    floorPlanId: row.floorPlanId,
    floorPlanName: row.floorPlan?.name ?? null,
    status: row.status,
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    lastError: row.lastError,
    zoneCount: row._count?.zones ?? 0,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
  }
}

export function parsePolygon(raw: string | null): VisionZonePoint[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const points: VisionZonePoint[] = []
    for (const entry of parsed) {
      if (entry == null || typeof entry !== 'object') continue
      const { x, y } = entry as Record<string, unknown>
      const nx = Number(x)
      const ny = Number(y)
      if (!Number.isFinite(nx) || !Number.isFinite(ny)) continue
      points.push({ x: nx, y: ny })
    }
    return points
  } catch {
    return []
  }
}

export function serializeZone(row: VisionZoneRow): VisionZoneDTO {
  return {
    id: row.id,
    cameraId: row.cameraId,
    cameraCode: row.camera.code,
    name: row.name,
    kind: row.kind,
    tableId: row.tableId,
    tableName: row.table?.name ?? null,
    floorPlanId: row.table?.floorPlanId ?? row.camera.floorPlanId ?? null,
    polygon: parsePolygon(row.polygon),
    seats: row.seats,
    active: row.active,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

export function serializeVisionEvent(row: VisionEvent): VisionEventDTO {
  return {
    id: row.id,
    eventId: row.eventId,
    type: row.type,
    cameraCode: row.cameraCode,
    zoneId: row.zoneId,
    tableId: row.tableId,
    peopleCount: row.peopleCount,
    confidence: row.confidence,
    detectedAt: row.detectedAt.toISOString(),
    outcome: row.outcome as VisionEventDTO['outcome'],
    outcomeDetail: row.outcomeDetail,
    model: row.model,
    receivedAt: row.receivedAt.toISOString(),
  }
}

/**
 * Serialize a movement candidate. `order` (when provided) supplies the
 * orderTotal + live currentState fields — it is fetched separately because
 * MovementCandidate carries orderId without a Prisma relation to Order.
 */
export function serializeMovement(
  row: MovementRow,
  order?: MovementOrderInfo | null,
): MovementCandidateDTO {
  return {
    id: row.id,
    fromTableId: row.fromTableId,
    fromTableName: row.fromTable.name,
    toTableId: row.toTableId,
    toTableName: row.toTable.name,
    peopleCount: row.peopleCount,
    confidence: row.confidence,
    orderId: row.orderId,
    orderTotal: order ? round2(order.totalAmount) : null,
    detectedAt: row.detectedAt.toISOString(),
    status: row.status,
    evidence: parseEvidence(row.evidence),
    decidedByName: row.decidedByName,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decisionReason: row.decisionReason,
    appliedAt: row.appliedAt ? row.appliedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    currentState: {
      fromTableStatus: row.fromTable.status,
      toTableStatus: row.toTable.status,
      orderStatus: order?.status ?? null,
      orderTableId: order?.tableId ?? null,
    },
  }
}

/** Serialize ONE movement with its live order info (single query). */
export async function serializeMovementWithOrder(row: MovementRow): Promise<MovementCandidateDTO> {
  const order =
    row.orderId != null
      ? await db.order.findUnique({
          where: { id: row.orderId },
          select: { id: true, status: true, tableId: true, totalAmount: true },
        })
      : null
  return serializeMovement(row, order)
}

/** Serialize a movement LIST with one batched order lookup. */
export async function serializeMovementsWithOrders(
  rows: MovementRow[],
): Promise<MovementCandidateDTO[]> {
  const orderIds = Array.from(
    new Set(rows.map((row) => row.orderId).filter((id): id is number => id != null)),
  )
  const orders = orderIds.length
    ? await db.order.findMany({
        where: { id: { in: orderIds } },
        select: { id: true, status: true, tableId: true, totalAmount: true },
      })
    : []
  const orderById = new Map(orders.map((order) => [order.id, order]))
  return rows.map((row) => serializeMovement(row, row.orderId != null ? orderById.get(row.orderId) ?? null : null))
}

/** Serialize a table's vision state (fetches config; read-time resolution). */
export async function serializeTableState(
  row: VisionTableStateRow,
  cameraOnline: boolean,
): Promise<VisionTableStateDTO> {
  const config = await getVisionConfig()
  return serializeTableStateWithConfig(row, cameraOnline, config, new Date())
}

export function serializeTableStateWithConfig(
  row: VisionTableStateRow,
  cameraOnline: boolean,
  config: VisionConfigDTO,
  now: Date,
): VisionTableStateDTO {
  const effective = resolveEffectiveVisionState(row, config, now)
  return {
    state: effective.state,
    peopleCount: effective.peopleCount,
    confidence: round2(effective.confidence),
    stateSince: effective.stateSince ? effective.stateSince.toISOString() : null,
    lastEventAt: row.lastEventAt ? row.lastEventAt.toISOString() : null,
    manualHoldUntil: row.manualHoldUntil ? row.manualHoldUntil.toISOString() : null,
    cameraOnline,
  }
}

// ─── Movement decisions (HUMAN confirmation — safety path) ───────────

async function loadMovementOr404(movementId: number): Promise<MovementRow> {
  const candidate = await db.movementCandidate.findUnique({
    where: { id: movementId },
    include: MOVEMENT_INCLUDE,
  })
  if (!candidate) throw new ApiError('Movement candidate not found', 404)
  return candidate
}

async function reloadMovement(movementId: number): Promise<MovementRow> {
  return db.movementCandidate.findUniqueOrThrow({
    where: { id: movementId },
    include: MOVEMENT_INCLUDE,
  })
}

async function loadOrderWithRelations(orderId: number): Promise<Order | undefined> {
  const order = await db.order.findUnique({ where: { id: orderId }, include: ORDER_INCLUDE })
  return order ? serializeOrder(order) : undefined
}

/** Vision-state updates after a human-confirmed physical move. */
async function applyMoveVisionStates(
  fromTableId: number,
  toTableId: number,
  peopleCount: number,
): Promise<void> {
  const now = new Date()
  await db.visionTableState.upsert({
    where: { tableId: fromTableId },
    update: {
      state: 'empty',
      peopleCount: 0,
      confidence: 1,
      stateSince: now,
      pendingEmptySince: null,
      manualHoldUntil: null,
      lastEventAt: now,
    },
    create: {
      tableId: fromTableId,
      state: 'empty',
      peopleCount: 0,
      confidence: 1,
      stateSince: now,
      lastEventAt: now,
    },
  })
  await db.visionTableState.upsert({
    where: { tableId: toTableId },
    update: {
      state: 'occupied',
      peopleCount,
      confidence: 1, // human-confirmed observation
      stateSince: now,
      pendingEmptySince: null,
      manualHoldUntil: null,
      lastEventAt: now,
    },
    create: {
      tableId: toTableId,
      state: 'occupied',
      peopleCount,
      confidence: 1,
      stateSince: now,
      lastEventAt: now,
    },
  })
}

export type MovementDecisionResult = {
  movement: MovementCandidateDTO
  order?: Order
}

/**
 * Confirm an AI-detected movement. mode 'table_and_order' re-houses the open
 * order with the EXACT POS transfer semantics (rehouseOpenOrder) inside a
 * transaction, after re-validating the LIVE state. mode 'table_only' never
 * touches orders or POS table status — it only confirms the seating change.
 */
export async function confirmMovement(
  user: SessionPayload,
  movementId: number,
  mode: 'table_and_order' | 'table_only',
  reason?: string,
): Promise<MovementDecisionResult> {
  const candidate = await loadMovementOr404(movementId)
  const now = new Date()

  // Already-decided candidates
  if (candidate.status === 'confirmed') {
    if (candidate.appliedAt != null) {
      // idempotent when the operational state already reflects the move
      if (mode === 'table_only') {
        return { movement: await serializeMovementWithOrder(candidate) }
      }
      if (candidate.orderId != null) {
        const order = await db.order.findUnique({ where: { id: candidate.orderId } })
        if (order && order.tableId === candidate.toTableId) {
          return {
            movement: await serializeMovementWithOrder(candidate),
            order: await loadOrderWithRelations(candidate.orderId),
          }
        }
      }
      throw new ApiError('Already confirmed', 409)
    }
    throw new ApiError('Already confirmed', 409)
  }
  if (candidate.status === 'rejected' || candidate.status === 'expired') {
    throw new ApiError(
      `Movement was already ${candidate.status} — create a new detection if needed`,
      409,
    )
  }
  if (candidate.status === 'conflict') {
    throw new ApiError('Conflicting state — review required', 409)
  }

  // status === 'pending' → re-validate LIVE state (hard safety rule)
  if (mode === 'table_and_order' && candidate.orderId != null) {
    const order = await db.order.findUnique({ where: { id: candidate.orderId } })
    if (!order || order.status !== 'open') {
      await db.movementCandidate.update({
        where: { id: candidate.id },
        data: {
          status: 'conflict',
          decisionReason: 'order is no longer open',
          decidedBy: user.userId,
          decidedByName: user.name,
          decidedAt: now,
        },
      })
      throw new ApiError('Order is no longer open — movement needs review', 409)
    }
    if (order.tableId === candidate.toTableId) {
      // someone already moved it — idempotent success
      const updated = await db.movementCandidate.update({
        where: { id: candidate.id },
        data: {
          status: 'confirmed',
          decidedBy: user.userId,
          decidedByName: user.name,
          decidedAt: now,
          decisionReason: reason ?? null,
          appliedAt: now,
        },
        include: MOVEMENT_INCLUDE,
      })
      await logAudit({
        user,
        action: 'vision.movementConfirm',
        entity: 'vision',
        entityId: candidate.id,
        details: `AI movement ${candidate.fromTable.name} → ${candidate.toTable.name} confirmed by ${user.name} (mode table_and_order, ${candidate.peopleCount} guests, ${Math.round(candidate.confidence * 100)}% conf, order #${order.id} already on target table)`,
      })
      return {
        movement: await serializeMovementWithOrder(updated),
        order: await loadOrderWithRelations(order.id),
      }
    }
    if (order.tableId !== candidate.fromTableId) {
      await db.movementCandidate.update({
        where: { id: candidate.id },
        data: {
          status: 'conflict',
          decisionReason: 'order is no longer on the source table',
          decidedBy: user.userId,
          decidedByName: user.name,
          decidedAt: now,
        },
      })
      throw new ApiError('Order is no longer on the source table — movement needs review', 409)
    }
    // Target table checks (live)
    if (!candidate.toTable.active) {
      throw new ApiError('Target table is not active', 400)
    }
    if (candidate.toTable.status === 'dirty') {
      throw new ApiError('Target table needs cleaning first', 409)
    }
    const otherOpen = await findOpenOrderOnTable(candidate.toTableId, candidate.orderId)
    if (otherOpen) {
      throw new ApiError('Target table already has another open order', 409)
    }

    // THE ONLY path where vision writes operational state — the exact POS
    // transfer transaction, reused from lib/orders.
    await db.$transaction(async (tx) => {
      await rehouseOpenOrder(tx, order, candidate.toTableId)
      await tx.movementCandidate.update({
        where: { id: candidate.id },
        data: {
          status: 'confirmed',
          decidedBy: user.userId,
          decidedByName: user.name,
          decidedAt: now,
          decisionReason: reason ?? null,
          appliedAt: now,
        },
      })
    })
    await applyMoveVisionStates(candidate.fromTableId, candidate.toTableId, candidate.peopleCount)

    await logAudit({
      user,
      action: 'vision.movementConfirm',
      entity: 'vision',
      entityId: candidate.id,
      details: `AI movement ${candidate.fromTable.name} → ${candidate.toTable.name} confirmed by ${user.name} (mode table_and_order, ${candidate.peopleCount} guests, ${Math.round(candidate.confidence * 100)}% conf, order #${order.id} moved)`,
    })
    return {
      movement: await serializeMovementWithOrder(await reloadMovement(candidate.id)),
      order: await loadOrderWithRelations(order.id),
    }
  }

  // mode 'table_only' (or walk-in movement without an order): confirm the
  // physical seating change only — NO order/POS writes at all.
  const updated = await db.movementCandidate.update({
    where: { id: candidate.id },
    data: {
      status: 'confirmed',
      decidedBy: user.userId,
      decidedByName: user.name,
      decidedAt: now,
      decisionReason: reason ?? null,
      appliedAt: now,
    },
    include: MOVEMENT_INCLUDE,
  })
  await applyMoveVisionStates(candidate.fromTableId, candidate.toTableId, candidate.peopleCount)
  await logAudit({
    user,
    action: 'vision.movementConfirm',
    entity: 'vision',
    entityId: candidate.id,
    details: `AI movement ${candidate.fromTable.name} → ${candidate.toTable.name} confirmed by ${user.name} (mode table_only, ${candidate.peopleCount} guests, ${Math.round(candidate.confidence * 100)}% conf — order untouched)`,
  })
  return { movement: await serializeMovementWithOrder(updated) }
}

/** Reject a pending AI movement (idempotent when already rejected). */
export async function rejectMovement(
  user: SessionPayload,
  movementId: number,
  reason?: string,
): Promise<{ movement: MovementCandidateDTO }> {
  const candidate = await loadMovementOr404(movementId)
  const now = new Date()

  if (candidate.status === 'rejected') {
    return { movement: await serializeMovementWithOrder(candidate) } // idempotent no-op
  }
  if (candidate.status === 'confirmed') {
    if (candidate.appliedAt != null) {
      throw new ApiError('Already confirmed — use undo instead', 409)
    }
    throw new ApiError('Already confirmed', 409)
  }

  const updated = await db.movementCandidate.update({
    where: { id: candidate.id },
    data: {
      status: 'rejected',
      decidedBy: user.userId,
      decidedByName: user.name,
      decidedAt: now,
      decisionReason: reason ?? null,
    },
    include: MOVEMENT_INCLUDE,
  })
  await logAudit({
    user,
    action: 'vision.movementReject',
    entity: 'vision',
    entityId: candidate.id,
    details: `AI movement ${candidate.fromTable.name} → ${candidate.toTable.name} rejected by ${user.name}${reason ? ` — ${reason}` : ''}`,
  })
  return { movement: await serializeMovementWithOrder(updated) }
}

/**
 * Undo a confirmed movement. table_and_order movements re-validate and move
 * the order back (exact transfer semantics); table_only movements revert the
 * vision states only. Never forces a conflicting state — 409 instead.
 */
export async function undoMovement(
  user: SessionPayload,
  movementId: number,
  reason?: string,
): Promise<MovementDecisionResult> {
  const candidate = await loadMovementOr404(movementId)
  const now = new Date()
  const undoReason = `undo: ${reason ?? 'reverted'}`

  if (candidate.status !== 'confirmed' || candidate.appliedAt == null) {
    throw new ApiError('Only confirmed & applied movements can be undone', 409)
  }

  if (candidate.orderId != null) {
    // table_and_order semantics — move the order back
    const order = await db.order.findUnique({ where: { id: candidate.orderId } })
    if (!order || order.status !== 'open') {
      throw new ApiError('Order is no longer open — cannot undo', 409)
    }
    if (order.tableId !== candidate.toTableId) {
      throw new ApiError('Order is no longer on the target table — cannot undo', 409)
    }
    if (!candidate.fromTable.active) {
      throw new ApiError('Source table is not active — cannot undo', 409)
    }
    if (candidate.fromTable.status === 'dirty') {
      throw new ApiError('Source table needs cleaning first', 409)
    }
    const otherOpen = await findOpenOrderOnTable(candidate.fromTableId, candidate.orderId)
    if (otherOpen) {
      throw new ApiError('Source table already has another open order', 409)
    }

    await db.$transaction(async (tx) => {
      await rehouseOpenOrder(tx, order, candidate.fromTableId)
      await tx.movementCandidate.update({
        where: { id: candidate.id },
        data: {
          status: 'rejected',
          decisionReason: undoReason,
          appliedAt: null,
          decidedBy: user.userId,
          decidedByName: user.name,
          decidedAt: now,
        },
      })
    })
    // vision states swap back (from occupied again, to empty)
    await applyMoveVisionStates(candidate.toTableId, candidate.fromTableId, candidate.peopleCount)
    await logAudit({
      user,
      action: 'vision.movementUndo',
      entity: 'vision',
      entityId: candidate.id,
      details: `AI movement ${candidate.fromTable.name} → ${candidate.toTable.name} undone by ${user.name} — order #${order.id} moved back to ${candidate.fromTable.name}${reason ? ` (${reason})` : ''}`,
    })
    return {
      movement: await serializeMovementWithOrder(await reloadMovement(candidate.id)),
      order: await loadOrderWithRelations(order.id),
    }
  }

  // table_only — revert the vision states only
  const updated = await db.movementCandidate.update({
    where: { id: candidate.id },
    data: {
      status: 'rejected',
      decisionReason: undoReason,
      appliedAt: null,
      decidedBy: user.userId,
      decidedByName: user.name,
      decidedAt: now,
    },
    include: MOVEMENT_INCLUDE,
  })
  await applyMoveVisionStates(candidate.toTableId, candidate.fromTableId, candidate.peopleCount)
  await logAudit({
    user,
    action: 'vision.movementUndo',
    entity: 'vision',
    entityId: candidate.id,
    details: `AI movement ${candidate.fromTable.name} → ${candidate.toTable.name} undone by ${user.name} (table_only — states reverted${reason ? `, ${reason}` : ''})`,
  })
  return { movement: await serializeMovementWithOrder(updated) }
}

// ─── Manual override ─────────────────────────────────────────────────

/**
 * Human override of a table's observational state: confidence 1 (human
 * evidence) and a manual hold freezing AI display state for
 * config.manualHoldMinutes.
 */
export async function overrideTableState(
  user: SessionPayload,
  tableId: number,
  state: 'occupied' | 'empty',
  peopleCount?: number,
  reason?: string,
): Promise<VisionTableStateDTO> {
  const table = await db.restaurantTable.findUnique({ where: { id: tableId } })
  if (!table || !table.active) throw new ApiError('Table not found', 404)

  const config = await getVisionConfig()
  const now = new Date()
  const current = await db.visionTableState.findUnique({ where: { tableId } })
  const resolvedPeople =
    state === 'occupied' ? (peopleCount ?? (current?.peopleCount || 1)) : 0

  const row = await db.visionTableState.upsert({
    where: { tableId },
    update: {
      state,
      peopleCount: resolvedPeople,
      confidence: 1,
      stateSince: now,
      pendingEmptySince: null,
      manualHoldUntil: new Date(now.getTime() + config.manualHoldMinutes * 60_000),
      lastEventAt: now,
    },
    create: {
      tableId,
      state,
      peopleCount: resolvedPeople,
      confidence: 1,
      stateSince: now,
      lastEventAt: now,
      manualHoldUntil: new Date(now.getTime() + config.manualHoldMinutes * 60_000),
    },
  })

  await logAudit({
    user,
    action: 'vision.override',
    entity: 'vision',
    entityId: tableId,
    details: `Manual override ${table.name} → ${state} (${resolvedPeople} guests) by ${user.name}${reason ? ` — ${reason}` : ''}`,
  })

  // cameraOnline: the table's observing camera (first active zone)
  const zone = await db.visionZone.findFirst({
    where: { tableId, active: true },
    include: { camera: { select: { status: true, active: true } } },
    orderBy: { id: 'asc' },
  })
  const cameraOnline = zone ? zone.camera.active && zone.camera.status === 'online' : false
  return serializeTableStateWithConfig(row, cameraOnline, config, now)
}

// ─── Overview builder ────────────────────────────────────────────────

const SEVERITY_RANK: Record<string, number> = { critical: 3, warning: 2, info: 1 }

export async function buildVisionOverview(): Promise<VisionOverviewDTO> {
  const now = new Date()
  const config = await getVisionConfig()

  // Active cameras (+zoneCount +floor plan name)
  const cameras = await db.visionCamera.findMany({
    where: { active: true },
    include: {
      _count: { select: { zones: true } },
      floorPlan: { select: { name: true } },
    },
    orderBy: { code: 'asc' },
  })

  // Active zones mapped to tables (first zone per table wins)
  const zones = await db.visionZone.findMany({
    where: { active: true, tableId: { not: null } },
    include: { camera: { select: { code: true, status: true, active: true } } },
    orderBy: { id: 'asc' },
  })
  const zoneByTable = new Map<number, (typeof zones)[number]>()
  for (const zone of zones) {
    if (zone.tableId != null && !zoneByTable.has(zone.tableId)) zoneByTable.set(zone.tableId, zone)
  }

  // Floor plans + active tables with the POS polling extras
  const plans = await db.floorPlan.findMany({
    where: { active: true },
    include: { tables: { where: { active: true }, orderBy: { name: 'asc' } } },
    orderBy: { id: 'asc' },
  })
  const serializedPlans = await serializeFloorPlans(plans)

  const tableIds = plans.flatMap((plan) => plan.tables.map((table) => table.id))
  const stateRows = tableIds.length
    ? await db.visionTableState.findMany({ where: { tableId: { in: tableIds } } })
    : []
  const stateByTable = new Map(stateRows.map((row) => [row.tableId, row]))

  const pendingMovements = await db.movementCandidate.count({ where: { status: 'pending' } })

  let totalGuests = 0
  let occupiedTables = 0
  let availableTables = 0
  let posOccupied = 0
  let coveredTables = 0
  let mismatchCount = 0
  const dwellMinutes: number[] = []
  const alerts: VisionAlertDTO[] = []
  const lazyPersist: number[] = []

  const floors: VisionFloorDTO[] = serializedPlans.map((plan) => ({
    id: plan.id,
    name: plan.name,
    tables: plan.tables.map((table) => {
      const zone = zoneByTable.get(table.id) ?? null
      const cameraOnline = zone ? zone.camera.active && zone.camera.status === 'online' : false
      const stateRow = stateByTable.get(table.id) ?? null

      let vision: VisionTableStateDTO
      if (stateRow) {
        const effective = resolveEffectiveVisionState(stateRow, config, now)
        if (effective.state === 'empty' && stateRow.state === 'occupied') {
          // lazily persist the resolved vacancy transition (single node)
          lazyPersist.push(table.id)
        }
        vision = {
          state: effective.state,
          peopleCount: effective.peopleCount,
          confidence: round2(effective.confidence),
          stateSince: effective.stateSince ? effective.stateSince.toISOString() : null,
          lastEventAt: stateRow.lastEventAt ? stateRow.lastEventAt.toISOString() : null,
          manualHoldUntil: stateRow.manualHoldUntil ? stateRow.manualHoldUntil.toISOString() : null,
          cameraOnline,
        }
      } else {
        vision = {
          state: 'unknown',
          peopleCount: 0,
          confidence: 0,
          stateSince: null,
          lastEventAt: null,
          manualHoldUntil: null,
          cameraOnline: false,
        }
      }

      const openOrderId = table.openOrderId ?? null
      let mismatch: VisionFloorTableDTO['mismatch'] = 'none'
      if (vision.state === 'occupied' && openOrderId == null && (table.status === 'free' || table.status === 'dirty')) {
        mismatch = 'seated_no_order'
      } else if (vision.state === 'empty' && openOrderId != null) {
        mismatch = 'left_check_open'
      }

      // KPI aggregation
      if (vision.state === 'occupied') {
        occupiedTables += 1
        totalGuests += vision.peopleCount
        const since = stateRow?.stateSince
        if (since) dwellMinutes.push((now.getTime() - since.getTime()) / 60_000)
      } else if (vision.state === 'empty' && table.status === 'free') {
        availableTables += 1
      }
      if (openOrderId != null) posOccupied += 1
      if (zone != null) coveredTables += 1
      if (mismatch !== 'none') mismatchCount += 1

      // Alerts
      if (mismatch === 'seated_no_order' && vision.stateSince) {
        const since = new Date(vision.stateSince)
        const ageMinutes = (now.getTime() - since.getTime()) / 60_000
        if (ageMinutes >= config.serviceDelayMinutes) {
          alerts.push({
            kind: 'no_order',
            severity: ageMinutes >= 2 * config.serviceDelayMinutes ? 'critical' : 'warning',
            tableId: table.id,
            tableName: table.name,
            cameraCode: zone?.camera.code ?? null,
            messageKey: 'noOrder',
            since: vision.stateSince,
            peopleCount: vision.peopleCount,
          })
        }
      }
      if (mismatch === 'left_check_open') {
        const pendingSince = vision.stateSince
        const ageMinutes = pendingSince ? (now.getTime() - new Date(pendingSince).getTime()) / 60_000 : 0
        alerts.push({
          kind: 'left_check_open',
          severity: ageMinutes >= 2 * config.serviceDelayMinutes ? 'warning' : 'info',
          tableId: table.id,
          tableName: table.name,
          cameraCode: zone?.camera.code ?? null,
          messageKey: 'leftCheckOpen',
          since: pendingSince,
          peopleCount: vision.peopleCount,
        })
      }

      return {
        ...table,
        zoneId: zone?.id ?? null,
        zoneName: zone?.name ?? null,
        cameraCode: zone?.camera.code ?? null,
        vision,
        mismatch,
      }
    }),
  }))

  // Camera health alerts
  for (const camera of cameras) {
    if (camera.status === 'offline' || camera.status === 'error') {
      alerts.push({
        kind: camera.status === 'error' ? 'camera_error' : 'camera_offline',
        severity: camera.status === 'error' ? 'critical' : 'warning',
        tableId: null,
        tableName: null,
        cameraCode: camera.code,
        messageKey: camera.status === 'error' ? 'cameraError' : 'cameraOffline',
        since: camera.lastSeenAt ? camera.lastSeenAt.toISOString() : null,
        peopleCount: null,
      })
    }
  }

  // severity desc, then since desc (nulls last)
  alerts.sort((a, b) => {
    const rankDiff = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0)
    if (rankDiff !== 0) return rankDiff
    const aTime = a.since ? new Date(a.since).getTime() : -Infinity
    const bTime = b.since ? new Date(b.since).getTime() : -Infinity
    return bTime - aTime
  })

  // persist lazily-resolved vacancies so the state survives restarts
  for (const tableId of lazyPersist) {
    await db.visionTableState.updateMany({
      where: { tableId },
      data: { state: 'empty', peopleCount: 0, stateSince: now, pendingEmptySince: null },
    })
  }

  const avgDwell =
    dwellMinutes.length > 0
      ? Math.round((dwellMinutes.reduce((sum, m) => sum + m, 0) / dwellMinutes.length) * 10) / 10
      : null

  return {
    kpis: {
      totalGuests,
      occupiedTables,
      availableTables,
      posOccupied,
      pendingMovements,
      reviewRequired: pendingMovements + mismatchCount,
      coveredTables,
      occupancyPct:
        coveredTables > 0
          ? Math.round((100 * occupiedTables) / coveredTables * 10) / 10
          : 0,
      avgDwellMinutes: avgDwell,
      camerasOnline: cameras.filter((camera) => camera.status === 'online').length,
      camerasTotal: cameras.length,
    },
    cameras: cameras.map(serializeCamera),
    floors,
    alerts,
    config,
    updatedAt: now.toISOString(),
  }
}

// ─── Analytics builder ───────────────────────────────────────────────

type OccupancyPeriod = { tableId: number; start: Date; end: Date | null; peopleCount: number }

/** Minimal event projection shared by the analytics helpers. */
type VisionEventLite = {
  type: string
  outcome: string
  outcomeDetail: string | null
  payload: string | null
  peopleCount: number | null
}

/** True when an 'applied' event actually changed observational state. */
function isEffectiveAppliedEvent(row: VisionEventLite): boolean {
  if (row.outcome !== 'applied') return false
  const detail = row.outcomeDetail ?? ''
  if (detail.startsWith('vacancy grace') || detail.startsWith('manual hold')) return false
  return true
}

/** OCCUPIED vs EMPTY from the stored raw payload (fallback: peopleCount). */
function occupancyKindOf(row: VisionEventLite): 'OCCUPIED' | 'EMPTY' {
  try {
    if (row.payload) {
      const parsed: unknown = JSON.parse(row.payload)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const state = (parsed as Record<string, unknown>).occupancy_state
        if (state === 'OCCUPIED' || state === 'EMPTY') return state
      }
    }
  } catch {
    // fall through to the peopleCount heuristic
  }
  return (row.peopleCount ?? 0) > 0 ? 'OCCUPIED' : 'EMPTY'
}

/** CAMERA_STATUS payload value (fallback: never 'online'). */
function cameraStatusKindOf(row: VisionEventLite): string | null {
  try {
    if (row.payload) {
      const parsed: unknown = JSON.parse(row.payload)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const status = (parsed as Record<string, unknown>).status
        if (typeof status === 'string') return status
      }
    }
  } catch {
    // ignore
  }
  return null
}

/** Overlap in minutes between a period and one hour-of-day slot. */
function hourOverlapMinutes(period: OccupancyPeriod, dayStart: Date, hour: number): number {
  const slotStart = dayStart.getTime() + hour * 3_600_000
  const slotEnd = slotStart + 3_600_000
  const periodStart = period.start.getTime()
  const periodEnd = (period.end ?? new Date(8640000000000000)).getTime()
  const overlap = Math.min(periodEnd, slotEnd) - Math.max(periodStart, slotStart)
  return overlap > 0 ? overlap / 60_000 : 0
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

export async function buildVisionAnalytics(from: Date, to: Date): Promise<VisionAnalyticsDTO> {
  // ── occupancy periods from applied OCCUPANCY_CHANGED events ──
  const occupancyEvents = await db.visionEvent.findMany({
    where: { type: 'OCCUPANCY_CHANGED', detectedAt: { gte: from, lte: to } },
    orderBy: [{ tableId: 'asc' }, { detectedAt: 'asc' }],
  })

  const periodsByTable = new Map<number, OccupancyPeriod[]>()
  for (const row of occupancyEvents) {
    if (row.tableId == null) continue
    if (!isEffectiveAppliedEvent(row)) continue
    const list = periodsByTable.get(row.tableId) ?? []
    const kind = occupancyKindOf(row)
    if (kind === 'OCCUPIED') {
      const open = list.find((period) => period.end == null)
      if (open) {
        open.peopleCount = row.peopleCount ?? open.peopleCount // refresh party size
      } else {
        list.push({
          tableId: row.tableId,
          start: row.detectedAt,
          end: null,
          peopleCount: row.peopleCount ?? 0,
        })
      }
    } else {
      const open = list.find((period) => period.end == null)
      if (open) open.end = row.detectedAt
    }
    periodsByTable.set(row.tableId, list)
  }

  const allPeriods = Array.from(periodsByTable.values()).flat()
  const durationsMinutes = allPeriods.map(
    (period) => ((period.end ?? to).getTime() - period.start.getTime()) / 60_000,
  )
  const gaps: number[] = []
  for (const list of periodsByTable.values()) {
    const closed = list.slice().sort((a, b) => a.start.getTime() - b.start.getTime())
    for (let i = 1; i < closed.length; i += 1) {
      const previous = closed[i - 1]
      if (previous.end == null) continue
      const gap = (closed[i].start.getTime() - previous.end.getTime()) / 60_000
      if (gap > 0) gaps.push(gap)
    }
  }

  const avgDwellMinutes =
    durationsMinutes.length > 0
      ? round1(durationsMinutes.reduce((sum, d) => sum + d, 0) / durationsMinutes.length)
      : null
  const avgTurnoverMinutes =
    gaps.length > 0 ? round1(gaps.reduce((sum, g) => sum + g, 0) / gaps.length) : null
  const occupiedTableHours =
    Math.round((durationsMinutes.reduce((sum, d) => sum + d, 0) / 60) * 10) / 10
  const totalGuestsObserved = allPeriods.reduce((sum, period) => sum + period.peopleCount, 0)

  // ── occupancyByHour (estimate — see DTO note) ──
  const coveredTablesEstimate = Math.max(1, periodsByTable.size)
  const days: Date[] = []
  for (
    let day = new Date(from.getFullYear(), from.getMonth(), from.getDate());
    day <= to;
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
  ) {
    days.push(day)
  }
  const numDays = Math.max(1, days.length)
  const occupancyByHour: { hour: number; occupiedPct: number; avgGuests: number }[] = []
  for (let hour = 0; hour < 24; hour += 1) {
    let overlap = 0
    let guestWeighted = 0
    for (const period of allPeriods) {
      for (const dayStart of days) {
        const minutes = hourOverlapMinutes(period, dayStart, hour)
        if (minutes > 0) {
          overlap += minutes
          guestWeighted += minutes * period.peopleCount
        }
      }
    }
    occupancyByHour.push({
      hour,
      occupiedPct: Math.min(100, round1((100 * overlap) / (numDays * 60 * coveredTablesEstimate))),
      avgGuests: overlap > 0 ? round1(guestWeighted / overlap) : 0,
    })
  }

  // ── movement stats ──
  const movements = await db.movementCandidate.findMany({
    where: { detectedAt: { gte: from, lte: to } },
    select: { status: true },
  })
  const movementCounts = { total: movements.length, confirmed: 0, rejected: 0, pending: 0, conflict: 0, expired: 0 }
  for (const movement of movements) {
    if (movement.status === 'confirmed') movementCounts.confirmed += 1
    else if (movement.status === 'rejected') movementCounts.rejected += 1
    else if (movement.status === 'pending') movementCounts.pending += 1
    else if (movement.status === 'conflict') movementCounts.conflict += 1
    else if (movement.status === 'expired') movementCounts.expired += 1
  }
  const decided = movementCounts.confirmed + movementCounts.rejected
  const confirmRate = decided > 0 ? Math.round((movementCounts.confirmed / decided) * 100) / 100 : null

  // ── event stats ──
  const eventRows = await db.visionEvent.findMany({
    where: { detectedAt: { gte: from, lte: to } },
    select: {
      outcome: true,
      type: true,
      cameraCode: true,
      detectedAt: true,
      payload: true,
      outcomeDetail: true,
      peopleCount: true,
    },
  })
  const eventStats = {
    total: eventRows.length,
    applied: eventRows.filter((row) => row.outcome === 'applied').length,
    duplicates: eventRows.filter((row) => row.outcome === 'duplicate').length,
    stale: eventRows.filter((row) => row.outcome === 'stale').length,
    lowConfidence: eventRows.filter((row) => row.outcome === 'low_confidence').length,
  }

  // ── per-table (top 10 by total dwell) ──
  const tableIds = Array.from(periodsByTable.keys())
  const tables = tableIds.length
    ? await db.restaurantTable.findMany({ where: { id: { in: tableIds } }, select: { id: true, name: true } })
    : []
  const tableNameById = new Map(tables.map((table) => [table.id, table.name]))
  const perTable = Array.from(periodsByTable.entries())
    .map(([tableId, list]) => {
      const totalDwell = round1(
        list.reduce((sum, period) => sum + ((period.end ?? to).getTime() - period.start.getTime()) / 60_000, 0),
      )
      const turnoverCount = list.filter((period) => period.end != null).length - 1
      return {
        tableId,
        name: tableNameById.get(tableId) ?? `Table ${tableId}`,
        occupiedPeriods: list.length,
        totalDwellMinutes: Math.max(0, totalDwell),
        avgDwellMinutes: list.length > 0 ? round1(totalDwell / list.length) : null,
        turnoverCount: Math.max(0, turnoverCount),
      }
    })
    .sort((a, b) => b.totalDwellMinutes - a.totalDwellMinutes)
    .slice(0, 10)

  // ── camera uptime ──
  const eventsByCamera = new Map<string, typeof eventRows>()
  for (const row of eventRows) {
    const list = eventsByCamera.get(row.cameraCode) ?? []
    list.push(row)
    eventsByCamera.set(row.cameraCode, list)
  }
  const cameraCodes = Array.from(eventsByCamera.keys())
  const cameraRows = cameraCodes.length
    ? await db.visionCamera.findMany({
        where: { code: { in: cameraCodes } },
        select: { code: true, lastSeenAt: true },
      })
    : []
  const lastSeenByCode = new Map(cameraRows.map((camera) => [camera.code, camera.lastSeenAt]))
  const cameraUptime = cameraCodes.map((code) => {
    const rows = eventsByCamera.get(code) ?? []
    const statusRows = rows.filter((row) => row.type === 'CAMERA_STATUS')
    const onlineRows = statusRows.filter(
      (row) => row.outcome === 'applied' && cameraStatusKindOf(row) === 'online',
    )
    return {
      cameraCode: code,
      events: rows.length,
      onlinePct: statusRows.length > 0 ? round1((100 * onlineRows.length) / statusRows.length) : 0,
      lastSeenAt: lastSeenByCode.get(code)?.toISOString() ?? null,
    }
  })

  // ── revenue per occupied table-hour ──
  let revenuePerOccupiedTableHour: number | null = null
  if (occupiedTableHours > 0) {
    const paidAgg = await db.order.aggregate({
      where: { status: 'paid', closedAt: { gte: from, lte: to } },
      _sum: { totalAmount: true },
    })
    revenuePerOccupiedTableHour = round2((paidAgg._sum.totalAmount ?? 0) / occupiedTableHours)
  }

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    totalGuestsObserved,
    avgDwellMinutes,
    avgTurnoverMinutes,
    occupiedTableHours,
    revenuePerOccupiedTableHour,
    occupancyByHour,
    movementStats: { ...movementCounts, confirmRate },
    eventStats,
    perTable,
    cameraUptime,
  }
}
