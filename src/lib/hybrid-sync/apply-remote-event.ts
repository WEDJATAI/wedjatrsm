/**
 * R30 hybrid sync — remote-event ingestion (the receiving side).
 *
 * ingestRemoteEvent() is the ONE function both receivers use:
 *  - POST /api/hybrid/push (a peer device pushing its outbox batch to us)
 *  - the local pull cycle (applying events fetched from the cloud target)
 *
 * Guarantees:
 *  - IDEMPOTENT: an eventId already recorded is never applied twice — a
 *    duplicate delivery is acked as a no-op (a retried batch can never
 *    duplicate a transaction).
 *  - POLICY-DRIVEN: every apply/skip decision follows the entity registry
 *    (entity-policy.ts). Decisions that are NOT silent resolutions are
 *    recorded as HybridConflict rows for human review.
 *  - ATOMIC: the business write + the in-record + the conflict record commit
 *    in ONE transaction. An FK-parent-missing event rolls back entirely and
 *    is recorded as status 'failed' so the pull cycle retries it later
 *    (the parent usually arrives in a subsequent batch).
 */
import { Prisma } from '@prisma/client'
import type { HybridEvent } from '@prisma/client'

import { db } from '@/lib/db'
import { resolvePolicy } from './entity-policy'
import { coercePayload, hybridModelFor } from './dmmf'
import { canonicalJson, hexGreater, sha256Hex } from './serialization'
import { snapshotRow } from './outbox'
import { backoffMs } from './retry'
import { HYBRID_IN_MAX_ATTEMPTS } from './constants'

/** A remote event as it rides the wire (push body / pull response). */
export type RemoteEvent = {
  eventId: string
  deviceId: string
  entity: string
  entityId: number
  operation: string // 'create' | 'update' | 'delete'
  revision: number
  payloadHash: string
  payload: Record<string, unknown>
}

export type IngestOutcome = 'applied' | 'skipped' | 'conflict' | 'failed'

export type IngestResult = {
  outcome: IngestOutcome
  /** why it was skipped / failed (machine-readable, short) */
  reason?: string
  /** conflict resolution recorded (outcome 'conflict') */
  resolution?: string
  /** whether a business write happened alongside a recorded conflict */
  applied?: boolean
}

type LooseDelegate = {
  findUnique: (args: { where: { id: number } }) => Promise<Record<string, unknown> | null>
  upsert: (args: {
    where: { id: number }
    update: Record<string, unknown>
    create: Record<string, unknown>
  }) => Promise<unknown>
  delete: (args: { where: { id: number } }) => Promise<unknown>
}

function delegateFor(client: unknown, accessor: string): LooseDelegate {
  const delegate = (client as unknown as Record<string, LooseDelegate | undefined>)[accessor]
  if (!delegate) throw new Error(`missing prisma delegate ${accessor}`)
  return delegate
}

function isPrismaError(err: unknown, code: string): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === code
}

function shortError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 120)
}

function hashOfRow(row: Record<string, unknown> | null): string {
  return row ? sha256Hex(canonicalJson(snapshotRow(row))) : ''
}

// ─── public API ───────────────────────────────────────────────────────

/**
 * Dedupe + policy + apply + in-record, in one call. Duplicate eventIds are
 * 'skipped' (never a second apply).
 */
export async function ingestRemoteEvent(evt: RemoteEvent): Promise<IngestResult> {
  const existing = await db.hybridEvent.findUnique({ where: { eventId: evt.eventId } })
  if (existing) {
    // p21: a RE-DELIVERY of an event whose recorded apply FAILED must never
    // be acked as a duplicate no-op — the business write never landed, and
    // acking it strands the sender (it stops retrying while this side keeps
    // the failure). The usual cause (a missing FK parent) has often arrived
    // in an earlier batch of this very push — retry right now.
    if (existing.direction === 'in' && existing.status === 'failed') {
      return retryInEvent(existing)
    }
    return { outcome: 'skipped', reason: 'duplicate' }
  }
  return processRemoteEvent(evt, null)
}

/** Simple contract used by the pull cycle. */
export async function applyRemoteEvent(evt: RemoteEvent): Promise<IngestOutcome> {
  return (await ingestRemoteEvent(evt)).outcome
}

/**
 * Re-attempt an event previously recorded as status 'failed' (FK parent was
 * missing, transient constraint). Increments the attempt budget and applies
 * backoff on failure; marks the row applied on success.
 */
export async function retryInEvent(row: HybridEvent): Promise<IngestResult> {
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>
  } catch {
    await db.hybridEvent.update({
      where: { id: row.id },
      data: { status: 'dead', lastError: 'unparseable-payload' },
    })
    return { outcome: 'failed', reason: 'unparseable-payload' }
  }
  const evt: RemoteEvent = {
    eventId: row.eventId,
    deviceId: row.deviceId,
    entity: row.entity,
    entityId: row.entityId,
    operation: row.operation,
    revision: row.revision,
    payloadHash: row.payloadHash,
    payload,
  }
  // record the attempt first (even if it succeeds, the budget is spent)
  await db.hybridEvent.update({
    where: { id: row.id },
    data: { attempts: { increment: 1 } },
  })
  return processRemoteEvent(evt, row.id)
}

// ─── policy engine ────────────────────────────────────────────────────

type Decision =
  | { kind: 'apply' }
  | {
      kind: 'skip'
      reason: string
      resolution: string
      details: string
      localHash: string
    }
  | {
      kind: 'apply-with-conflict'
      resolution: string
      details: string
      localHash: string
    }

/**
 * Origin-authority guard: while the parent order is open/deferred AND has a
 * stamped origin device, only that device's events may touch it (or its
 * items). Everyone else is recorded as a conflict and skipped — a live check
 * on the originating terminal must never be rewritten mid-service.
 */
async function originAuthorityGuard(
  evt: RemoteEvent,
  localRow: Record<string, unknown> | null,
): Promise<{ details: string; localHash: string } | null> {
  let order: { status: unknown; originDeviceId: string | null } | null = null
  if (evt.entity === 'Order') {
    order = localRow
      ? { status: localRow.status, originDeviceId: (localRow.originDeviceId as string | null) ?? null }
      : null
  } else if (evt.entity === 'OrderItem') {
    const parentId = localRow ? Number(localRow.orderId) : Number(evt.payload.orderId)
    if (Number.isInteger(parentId) && parentId > 0) {
      order = await db.order.findUnique({
        where: { id: parentId },
        select: { status: true, originDeviceId: true },
      })
    }
  }
  if (
    order &&
    (order.status === 'open' || order.status === 'deferred') &&
    order.originDeviceId &&
    evt.deviceId !== order.originDeviceId
  ) {
    return {
      details: `order-${order.status}-origin-${order.originDeviceId.slice(0, 8)}`,
      localHash: hashOfRow(localRow),
    }
  }
  return null
}

/**
 * p20 revision floor: the newest state already recorded for this entity row
 * must never be overwritten by a stale (lower-revision) payload that arrives
 * late — found live after the out-of-order batch race: final-gate orders'
 * rev-1 create payloads landed on the cloud AFTER their rev-3 cancels and
 * re-opened them. Returns 'no-op' when the event is an exact duplicate of the
 * known state, or a Decision otherwise. Shared by the revision-aware policy
 * and (as a floor under the guard) by origin-authority.
 */
async function revisionFloorDecision(
  evt: RemoteEvent,
  retryRowId: number | null,
): Promise<Decision | 'no-op'> {
  // P6 fix: when RETRYING a previously-failed in-event, the row being
  // retried must NOT count as the "latest known revision" of itself —
  // otherwise a same-rev/same-hash retry resolves to the no-op branch
  // and the business write is silently lost (found by P6 failure
  // testing: a malformed-payload apply failure, payload repaired, retry
  // marked the row 'applied' without ever writing the data).
  const latest = await db.hybridEvent.findFirst({
    where: {
      entity: evt.entity,
      entityId: evt.entityId,
      ...(retryRowId !== null ? { id: { not: retryRowId } } : {}),
    },
    orderBy: [{ revision: 'desc' }, { id: 'desc' }],
  })
  const localRev = latest?.revision ?? 0
  if (evt.revision > localRev) {
    return { kind: 'apply' }
  }
  if (evt.revision < localRev) {
    return {
      kind: 'skip',
      reason: 'stale-revision',
      resolution: 'local-wins',
      details: `remote-rev-${evt.revision}-lt-local-${localRev}`,
      localHash: latest?.payloadHash ?? '',
    }
  }
  if (latest && latest.payloadHash === evt.payloadHash) return 'no-op'
  if (latest && hexGreater(latest.payloadHash, evt.payloadHash)) {
    return {
      kind: 'skip',
      reason: 'revision-tiebreak',
      resolution: 'local-wins',
      details: 'local-hash-wins',
      localHash: latest.payloadHash,
    }
  }
  return {
    kind: 'apply-with-conflict',
    resolution: 'remote-wins',
    details: 'remote-hash-wins',
    localHash: latest?.payloadHash ?? '',
  }
}

async function processRemoteEvent(
  evt: RemoteEvent,
  retryRowId: number | null,
): Promise<IngestResult> {
  const policy = resolvePolicy(evt.entity)
  const model = hybridModelFor(evt.entity)
  if (!policy || !model) return { outcome: 'failed', reason: 'unknown-entity' }

  const localRow = await delegateFor(db, model.accessor).findUnique({ where: { id: evt.entityId } })

  // ── policy decision ──
  let decision: Decision = { kind: 'apply' }
  switch (policy) {
    case 'append-only': {
      // financial/audit rows: inserts only — updates/deletes are rejected
      // (and a create onto an existing id is a duplicate, not an overwrite)
      if (evt.operation === 'create' && !localRow) {
        decision = { kind: 'apply' }
      } else {
        decision = {
          kind: 'skip',
          reason: 'append-only-violation',
          resolution: 'rejected',
          details:
            evt.operation === 'create'
              ? 'duplicate-id'
              : `${evt.operation}-on-${model.table}`,
          localHash: hashOfRow(localRow),
        }
      }
      break
    }
    case 'origin-authority': {
      const guard = await originAuthorityGuard(evt, localRow)
      if (guard) {
        decision = {
          kind: 'skip',
          reason: 'origin-authority',
          resolution: 'local-wins',
          details: guard.details,
          localHash: guard.localHash,
        }
      } else {
        // guard passed (we are the origin device, the order is closed, or no
        // origin is stamped) — p20: still enforce the revision floor so a
        // late-arriving stale payload (out-of-order batch delivery) can never
        // overwrite a newer state. Mirrors revision-aware semantics.
        const floor = await revisionFloorDecision(evt, retryRowId)
        if (floor === 'no-op') return finalizeNoOp(evt, retryRowId)
        decision = floor
      }
      break
    }
    case 'cloud-authoritative': {
      // reference/config: the cloud wins, but an un-acked LOCAL outbound edit
      // with different content is recorded so the divergence is visible.
      // p21: ALSO enforce the revision floor — without it, a stale payload
      // (an FK-failed event healed days later, or an out-of-order batch)
      // applies over a NEWER revision of the row: today's par stock was
      // stomped back to September values by exactly this. Menu fields are
      // slow-moving so the bug hid until stock became fast-changing.
      const floor = await revisionFloorDecision(evt, retryRowId)
      if (floor === 'no-op') return finalizeNoOp(evt, retryRowId)
      if (floor.kind === 'skip') {
        decision = floor
        break
      }
      const divergent = await db.hybridEvent.findFirst({
        where: {
          direction: 'out',
          entity: evt.entity,
          entityId: evt.entityId,
          status: { in: ['pending', 'inflight', 'failed'] },
          payloadHash: { not: evt.payloadHash },
        },
        orderBy: { id: 'desc' },
      })
      if (divergent) {
        decision = {
          kind: 'apply-with-conflict',
          resolution: 'remote-wins',
          details: 'local-unacked-divergence',
          localHash: divergent.payloadHash,
        }
      }
      break
    }
    case 'revision-aware': {
      const floor = await revisionFloorDecision(evt, retryRowId)
      if (floor === 'no-op') return finalizeNoOp(evt, retryRowId)
      decision = floor
      break
    }
  }

  // ── execute atomically ──
  try {
    await db.$transaction(async (tx) => {
      if (decision.kind !== 'skip') {
        const delegate = delegateFor(tx, model!.accessor)
        if (evt.operation === 'delete') {
          await delegate.delete({ where: { id: evt.entityId } }).catch((err: unknown) => {
            // already gone → delete is idempotent
            if (!isPrismaError(err, 'P2025')) throw err
          })
        } else {
          const data = coercePayload(model!, evt.payload)
          await delegate.upsert({ where: { id: evt.entityId }, update: data, create: data })
        }
      }
      if (decision.kind === 'skip' || decision.kind === 'apply-with-conflict') {
        await tx.hybridConflict.upsert({
          where: { eventId: evt.eventId },
          update: {}, // first record of this decision wins; duplicates are no-ops
          create: {
            eventId: evt.eventId,
            entity: evt.entity,
            entityId: evt.entityId,
            localHash: decision.localHash,
            remoteHash: evt.payloadHash,
            policy,
            resolution: decision.resolution,
            details: decision.details,
          },
        })
      }
      if (retryRowId !== null) {
        await tx.hybridEvent.update({
          where: { id: retryRowId },
          data: { status: 'applied', lastError: null, nextAttemptAt: null },
        })
      } else {
        await tx.hybridEvent.create({
          data: {
            eventId: evt.eventId,
            deviceId: evt.deviceId,
            entity: evt.entity,
            entityId: evt.entityId,
            operation: evt.operation,
            revision: evt.revision,
            payload: canonicalJson(evt.payload),
            payloadHash: evt.payloadHash,
            direction: 'in',
            status: 'applied',
          },
        })
      }
    })
  } catch (err) {
    // FK parent missing (or a constraint clash) → the whole transaction
    // rolled back; record the event as failed so the pull cycle retries it
    const reason = isPrismaError(err, 'P2003') ? 'fk-parent-missing' : shortError(err)
    await recordFailure(evt, retryRowId, reason)
    return { outcome: 'failed', reason }
  }

  if (decision.kind === 'skip') {
    return { outcome: 'conflict', reason: decision.reason, resolution: decision.resolution }
  }
  if (decision.kind === 'apply-with-conflict') {
    return { outcome: 'conflict', resolution: decision.resolution, applied: true }
  }
  return { outcome: 'applied' }
}

/** Same-revision same-content no-op: record the event as processed, write nothing. */
async function finalizeNoOp(evt: RemoteEvent, retryRowId: number | null): Promise<IngestResult> {
  try {
    if (retryRowId !== null) {
      await db.hybridEvent.update({
        where: { id: retryRowId },
        data: { status: 'applied', lastError: null, nextAttemptAt: null },
      })
    } else {
      await db.hybridEvent.create({
        data: {
          eventId: evt.eventId,
          deviceId: evt.deviceId,
          entity: evt.entity,
          entityId: evt.entityId,
          operation: evt.operation,
          revision: evt.revision,
          payload: canonicalJson(evt.payload),
          payloadHash: evt.payloadHash,
          direction: 'in',
          status: 'applied',
        },
      })
    }
  } catch (err) {
    const reason = shortError(err)
    await recordFailure(evt, retryRowId, reason)
    return { outcome: 'failed', reason }
  }
  return { outcome: 'skipped', reason: 'same-content' }
}

async function recordFailure(
  evt: RemoteEvent,
  retryRowId: number | null,
  reason: string,
): Promise<void> {
  try {
    if (retryRowId !== null) {
      const row = await db.hybridEvent.findUnique({ where: { id: retryRowId } })
      if (!row) return
      await db.hybridEvent.update({
        where: { id: retryRowId },
        data: {
          status: row.attempts >= HYBRID_IN_MAX_ATTEMPTS ? 'dead' : 'failed',
          lastError: reason,
          nextAttemptAt: new Date(Date.now() + backoffMs(row.attempts)),
        },
      })
    } else {
      await db.hybridEvent.create({
        data: {
          eventId: evt.eventId,
          deviceId: evt.deviceId,
          entity: evt.entity,
          entityId: evt.entityId,
          operation: evt.operation,
          revision: evt.revision,
          payload: canonicalJson(evt.payload),
          payloadHash: evt.payloadHash,
          direction: 'in',
          status: 'failed',
          attempts: 1,
          lastError: reason,
          nextAttemptAt: new Date(Date.now() + backoffMs(1)),
        },
      })
    }
  } catch (err) {
    console.error('[hybrid] failed to record event failure:', shortError(err))
  }
}
