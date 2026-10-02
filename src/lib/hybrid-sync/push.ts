/**
 * R30 hybrid sync — push cycle (outbox → cloud).
 *
 * One cycle: claim up to HYBRID_BATCH_SIZE pending outbox events (status
 * 'inflight' + attempt increment + batchId — the claim makes retries safe),
 * POST them to the cloud's /api/hybrid/push, then settle the batch:
 *  - 200        acked ids → 'acked'; rejected ids → back to 'pending' with
 *               backoff (or 'dead' when reason 'permanent'); ids in NEITHER
 *               list (receiver could not apply, e.g. FK parent missing) →
 *               back to 'pending' with backoff so they ride a later batch.
 *  - 401/403    auth problem — whole batch back to pending, cloud.authFailed
 *               flag set (surfaced in the health snapshot for the admin).
 *  - 429/5xx/network — whole batch back to pending with backoff, cloud
 *               marked unreachable; the local terminal keeps operating.
 *  - 400/422    batch permanently malformed — 'dead' (never retried).
 *
 * Events exceeding HYBRID_MAX_ATTEMPTS attempts never go back to pending —
 * they are moved to 'dead' and surface in /api/hybrid/errors.
 */
import { randomUUID } from 'node:crypto'

import { db } from '@/lib/db'
import { SYNC_KEY_TARGET_URL } from '@/lib/sync'
import { hybridFetch } from './cloud-client'
import { ensureLocalDevice, getLocalDevice } from './device-identity'
import { backoffMs } from './retry'
import {
  HYBRID_BATCH_SIZE,
  HYBRID_MAX_ATTEMPTS,
  HYBRID_PUSH_TIMEOUT_MS,
  STATE_CLOUD_AUTH_FAILED,
  STATE_CLOUD_LAST_CHECKED,
  STATE_CLOUD_REACHABLE,
  STATE_LAST_PUSH_AT,
  STATE_LOCAL_DEVICE_KEY,
} from './constants'
import { clearState, getState, setState } from './sync-state'

export type PushCycleResult = {
  pushed: number
  acked: number
  failed: number
  error?: string
}

/** Read the cloud target URL (shared AppSetting with the legacy sync engine). */
export async function readHybridTargetUrl(): Promise<string> {
  const row = await db.appSetting.findUnique({ where: { key: SYNC_KEY_TARGET_URL } })
  return (row?.value ?? '').trim()
}

async function markCloud(reachable: 'yes' | 'no', authFailed?: boolean): Promise<void> {
  await setState(STATE_CLOUD_REACHABLE, reachable)
  await setState(STATE_CLOUD_LAST_CHECKED, new Date().toISOString())
  if (authFailed === undefined) await clearState(STATE_CLOUD_AUTH_FAILED)
  else if (authFailed) await setState(STATE_CLOUD_AUTH_FAILED, '1')
}

/** Return claimed events to 'pending' with per-row backoff (or 'dead' at the budget). */
async function releaseToPending(ids: number[], lastError: string): Promise<void> {
  if (ids.length === 0) return
  const rows = await db.hybridEvent.findMany({
    where: { id: { in: ids } },
    select: { id: true, attempts: true },
  })
  for (const row of rows) {
    if (row.attempts >= HYBRID_MAX_ATTEMPTS) {
      await db.hybridEvent.update({
        where: { id: row.id },
        data: { status: 'dead', lastError },
      })
    } else {
      await db.hybridEvent.update({
        where: { id: row.id },
        data: {
          status: 'pending',
          lastError,
          nextAttemptAt: new Date(Date.now() + backoffMs(row.attempts)),
        },
      })
    }
  }
}

export async function runPushCycle(): Promise<PushCycleResult> {
  const target = await readHybridTargetUrl()
  if (!target) return { pushed: 0, acked: 0, failed: 0, error: 'no-target' }

  // local identity (created lazily on the very first real push)
  let device = await getLocalDevice()
  let deviceKey = await getState(STATE_LOCAL_DEVICE_KEY)
  if (!device || !deviceKey) {
    const identity = await ensureLocalDevice()
    device = await getLocalDevice()
    deviceKey = identity.deviceKey
    if (!device) return { pushed: 0, acked: 0, failed: 0, error: 'no-device' }
  }
  const deviceId = device.deviceId

  // ── claim a batch ──
  const now = new Date()
  const pending = await db.hybridEvent.findMany({
    where: {
      direction: 'out',
      status: 'pending',
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: { createdAt: 'asc' },
    take: HYBRID_BATCH_SIZE,
    select: { id: true },
  })
  if (pending.length === 0) return { pushed: 0, acked: 0, failed: 0 }

  const batchId = randomUUID()
  const claimedIds = pending.map((e) => e.id)
  await db.hybridEvent.updateMany({
    where: { id: { in: claimedIds }, status: 'pending' },
    data: { status: 'inflight', attempts: { increment: 1 }, batchId },
  })
  const claimedAll = await db.hybridEvent.findMany({ where: { id: { in: claimedIds } } })
  // an unparseable stored payload can never ride the wire — quarantine it
  const claimed = [] as typeof claimedAll
  for (const event of claimedAll) {
    try {
      JSON.parse(event.payload)
      claimed.push(event)
    } catch {
      await db.hybridEvent.update({
        where: { id: event.id },
        data: { status: 'dead', lastError: 'unparseable-payload' },
      })
    }
  }
  if (claimed.length === 0) return { pushed: 0, acked: 0, failed: 0 }

  // ── push ──
  const res = await hybridFetch(target, '/api/hybrid/push', {
    method: 'POST',
    deviceId,
    deviceKey,
    timeoutMs: HYBRID_PUSH_TIMEOUT_MS,
    body: {
      batchId,
      deviceId,
      events: claimed.map((e) => ({
        eventId: e.eventId,
        deviceId: e.deviceId,
        entity: e.entity,
        entityId: e.entityId,
        operation: e.operation,
        revision: e.revision,
        payloadHash: e.payloadHash,
        payload: JSON.parse(e.payload) as unknown,
        createdAt: e.createdAt.toISOString(),
      })),
    },
  })

  // ── settle ──
  if (res.ok && res.status === 200) {
    const body = (res.json ?? {}) as {
      acked?: string[]
      rejected?: Array<{ eventId: string; reason: string }>
    }
    const ackedIds = new Set((body.acked ?? []).map(String))
    const rejected = body.rejected ?? []

    const ackedRows = claimed.filter((e) => ackedIds.has(e.eventId))
    const rejectedEventIds = new Set(rejected.map((r) => String(r.eventId)))
    const notAckedRows = claimed.filter(
      (e) => !ackedIds.has(e.eventId) && !rejectedEventIds.has(e.eventId),
    )

    if (ackedRows.length > 0) {
      await db.hybridEvent.updateMany({
        where: { id: { in: ackedRows.map((e) => e.id) } },
        data: { status: 'acked', ackedAt: new Date(), lastError: null, nextAttemptAt: null },
      })
    }
    // rejected: permanent → dead; anything else → pending with backoff
    const permanentRows = claimed.filter(
      (e) => rejectedEventIds.has(e.eventId) && rejected.find((r) => String(r.eventId) === e.eventId)?.reason === 'permanent',
    )
    const softRejectedRows = claimed.filter(
      (e) => rejectedEventIds.has(e.eventId) && rejected.find((r) => String(r.eventId) === e.eventId)?.reason !== 'permanent',
    )
    if (permanentRows.length > 0) {
      await db.hybridEvent.updateMany({
        where: { id: { in: permanentRows.map((e) => e.id) } },
        data: { status: 'dead', lastError: 'rejected-permanent' },
      })
    }
    if (softRejectedRows.length > 0) {
      await releaseToPending(softRejectedRows.map((e) => e.id), 'rejected')
    }
    // receiver processed the batch but could not apply these (e.g. FK parent
    // missing on its side) — retry later when the parent has arrived
    if (notAckedRows.length > 0) {
      await releaseToPending(notAckedRows.map((e) => e.id), 'not-acked')
    }

    await markCloud('yes')
    await setState(STATE_LAST_PUSH_AT, new Date().toISOString())
    await db.hybridDevice.updateMany({
      where: { deviceId },
      data: { lastPushAt: new Date() },
    })
    return {
      pushed: claimed.length,
      acked: ackedRows.length,
      failed: softRejectedRows.length + notAckedRows.length + permanentRows.length,
    }
  }

  // 401/403 — device unknown/revoked on the cloud
  if (res.status === 401 || res.status === 403) {
    await releaseToPending(claimedIds, 'unauthorized')
    await markCloud('no', true)
    return { pushed: claimed.length, acked: 0, failed: claimed.length, error: 'unauthorized' }
  }

  // 400/422 — the batch itself is malformed; retrying cannot fix it
  if (res.status === 400 || res.status === 422) {
    await db.hybridEvent.updateMany({
      where: { id: { in: claimedIds } },
      data: { status: 'dead', lastError: `bad-request-${res.status}` },
    })
    await markCloud('yes') // the cloud answered — it is reachable
    return { pushed: claimed.length, acked: 0, failed: claimed.length, error: 'bad-request' }
  }

  // 429 / 5xx / network failure — transient, back off everything
  const lastError = res.status === 0 ? 'network' : `http-${res.status}`
  await releaseToPending(claimedIds, lastError)
  await markCloud('no')
  return { pushed: claimed.length, acked: 0, failed: claimed.length, error: lastError }
}
