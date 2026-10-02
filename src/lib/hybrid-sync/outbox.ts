/**
 * R30 hybrid sync — the durable outbox.
 *
 * THE CONTRACT: emitOutboxEvent must be called with the SAME Prisma
 * transaction/client as the business write. The HybridEvent row and the
 * business row commit (or roll back) TOGETHER — a business write can never
 * exist without its outbox event, and an outbox event can never exist
 * without its business write. Errors are deliberately NOT swallowed: an
 * outbox failure rolls back the business transaction (that is the point of
 * atomicity).
 *
 * Business write paths opt in like this:
 *   await db.$transaction(async (tx) => {
 *     const order = await tx.order.create({ data: {...} })
 *     await emitOutboxEvent(tx, { entity: 'Order', entityId: order.id, operation: 'create', row: order })
 *     return order
 *   })
 */
import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'

import { canonicalJson, sha256Hex } from './serialization'
import { STATE_LOCAL_DEVICE_ID } from './sync-state'

/** Prisma transaction handle (or the plain client — both expose the delegates). */
type Tx = Prisma.TransactionClient

export type OutboxEventInput = {
  entity: string
  entityId: number
  operation: 'create' | 'update' | 'delete'
  /** the business row as read/written in the same transaction */
  row: Record<string, unknown>
}

/** JSON-safe row snapshot: Date → ISO string, everything else passthrough. */
export function snapshotRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(row)) {
    out[field] = value instanceof Date ? value.toISOString() : value
  }
  return out
}

/**
 * Next revision for an entity row: max(revision)+1 over ALL HybridEvents
 * (both directions — local outbox revisions and received remote revisions
 * share the same counter so cross-device history stays totally ordered).
 */
export async function nextRevision(tx: Tx, entity: string, entityId: number): Promise<number> {
  const agg = await tx.hybridEvent.aggregate({
    where: { entity, entityId },
    _max: { revision: true },
  })
  return (agg._max.revision ?? 0) + 1
}

/**
 * Append one outbox event, reading the local device id THROUGH the tx so the
 * event stays atomic with the business write even on the very first call.
 * When no local identity exists yet (engine never ran, admin never touched
 * hybrid settings) the event is still recorded with deviceId 'unbound' —
 * the row is local-only until a later event carries the real identity.
 */
export async function emitOutboxEvent(tx: Tx, input: OutboxEventInput): Promise<void> {
  const stateRow = await tx.hybridSyncState.findUnique({ where: { key: STATE_LOCAL_DEVICE_ID } })
  const deviceId = stateRow?.value ?? 'unbound'

  const payload = canonicalJson(snapshotRow(input.row))
  const revision = await nextRevision(tx, input.entity, input.entityId)

  await tx.hybridEvent.create({
    data: {
      eventId: randomUUID(),
      deviceId,
      entity: input.entity,
      entityId: input.entityId,
      operation: input.operation,
      revision,
      payload,
      payloadHash: sha256Hex(payload),
      direction: 'out',
      status: 'pending',
    },
  })
}

/** Multi-event variant for writes that touch several rows (order + items + payment). */
export async function withOutboxEvents(tx: Tx, events: OutboxEventInput[]): Promise<void> {
  for (const event of events) {
    await emitOutboxEvent(tx, event)
  }
}
