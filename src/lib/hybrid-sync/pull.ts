/**
 * R30 hybrid sync — pull cycle (cloud → local apply).
 *
 * One cycle:
 *  1. RETRY: re-attempt previously received events parked as status 'failed'
 *     (usually an FK parent that had not arrived yet) while they are under
 *     the HYBRID_IN_MAX_ATTEMPTS budget — local healing, no cloud needed.
 *  2. PULL: GET /api/hybrid/pull?cursor&limit from the cloud target and apply
 *     each event via ingestRemoteEvent (same policy engine as the push
 *     route), then persist the new cursor + remaining count.
 *
 * The cursor is the cloud's HybridEvent autoincrement id — monotonic, so a
 * crashed cycle simply re-pulls from the last saved cursor (duplicate
 * deliveries are absorbed by eventId dedupe).
 */
import { db } from '@/lib/db'
import { hybridFetch } from './cloud-client'
import { ingestRemoteEvent, retryInEvent, type RemoteEvent } from './apply-remote-event'
import { ensureLocalDevice, getLocalDevice } from './device-identity'
import { readHybridTargetUrl } from './push'
import {
  HYBRID_IN_MAX_ATTEMPTS,
  HYBRID_PULL_LIMIT,
  HYBRID_PULL_TIMEOUT_MS,
  STATE_CLOUD_LAST_CHECKED,
  STATE_CLOUD_REACHABLE,
  STATE_LAST_PULL_AT,
  STATE_LOCAL_DEVICE_KEY,
  STATE_PULL_CURSOR,
  STATE_PULL_REMAINING,
} from './constants'
import { getState, setState } from './sync-state'

export type PullCycleResult = {
  applied: number
  skipped: number
  conflicts: number
  failed: number
  remaining: number
}

type PullResponseBody = {
  events?: Array<{
    cursorId: number
    eventId: string
    deviceId: string
    entity: string
    entityId: number
    operation: string
    revision: number
    payloadHash: string
    payload: Record<string, unknown>
    createdAt?: string
  }>
  nextCursor?: number
  remaining?: number
}

export async function runPullCycle(): Promise<PullCycleResult> {
  const result: PullCycleResult = {
    applied: 0,
    skipped: 0,
    conflicts: 0,
    failed: 0,
    remaining: 0,
  }

  // ── 1) local retry of failed in-events (FK gaps usually heal) ──
  const now = new Date()
  const failedRows = await db.hybridEvent.findMany({
    where: {
      direction: 'in',
      status: 'failed',
      attempts: { lt: HYBRID_IN_MAX_ATTEMPTS },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: { id: 'asc' },
    take: HYBRID_PULL_LIMIT,
  })
  for (const row of failedRows) {
    const retry = await retryInEvent(row)
    result[retry.outcome] = (result[retry.outcome] ?? 0) + 1
  }

  // ── 2) pull from the cloud target ──
  const target = await readHybridTargetUrl()
  if (!target) {
    const remaining = Number((await getState(STATE_PULL_REMAINING)) ?? 0)
    result.remaining = Number.isFinite(remaining) ? remaining : 0
    return result
  }

  let device = await getLocalDevice()
  let deviceKey = await getState(STATE_LOCAL_DEVICE_KEY)
  if (!device || !deviceKey) {
    const identity = await ensureLocalDevice()
    device = await getLocalDevice()
    deviceKey = identity.deviceKey
    if (!device) {
      result.remaining = Number((await getState(STATE_PULL_REMAINING)) ?? 0)
      return result
    }
  }
  const deviceId = device.deviceId

  const cursorRaw = await getState(STATE_PULL_CURSOR)
  const cursor = Number.isFinite(Number(cursorRaw)) ? Number(cursorRaw) : 0

  const res = await hybridFetch(
    target,
    `/api/hybrid/pull?cursor=${cursor}&limit=${HYBRID_PULL_LIMIT}`,
    { method: 'GET', deviceId, deviceKey, timeoutMs: HYBRID_PULL_TIMEOUT_MS },
  )

  if (!res.ok || res.status !== 200) {
    await setState(STATE_CLOUD_REACHABLE, 'no')
    await setState(STATE_CLOUD_LAST_CHECKED, new Date().toISOString())
    result.remaining = Number((await getState(STATE_PULL_REMAINING)) ?? 0)
    return result
  }

  const body = (res.json ?? {}) as PullResponseBody
  for (const wire of body.events ?? []) {
    const evt: RemoteEvent = {
      eventId: String(wire.eventId),
      deviceId: String(wire.deviceId),
      entity: String(wire.entity),
      entityId: Number(wire.entityId),
      operation: String(wire.operation),
      revision: Number(wire.revision),
      payloadHash: String(wire.payloadHash),
      payload: (wire.payload ?? {}) as Record<string, unknown>,
    }
    const outcome = await ingestRemoteEvent(evt)
    result[outcome.outcome] = (result[outcome.outcome] ?? 0) + 1
  }

  const nextCursor = Number(body.nextCursor)
  if (Number.isFinite(nextCursor)) await setState(STATE_PULL_CURSOR, String(nextCursor))
  const remaining = Number(body.remaining)
  result.remaining = Number.isFinite(remaining) ? remaining : 0
  if (Number.isFinite(remaining)) await setState(STATE_PULL_REMAINING, String(remaining))

  await setState(STATE_CLOUD_REACHABLE, 'yes')
  await setState(STATE_CLOUD_LAST_CHECKED, new Date().toISOString())
  await setState(STATE_LAST_PULL_AT, new Date().toISOString())
  await db.hybridDevice.updateMany({ where: { deviceId }, data: { lastPullAt: new Date() } })

  return result
}
