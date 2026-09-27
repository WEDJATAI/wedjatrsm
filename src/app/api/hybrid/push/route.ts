// /api/hybrid/push — R30 receiving endpoint for rsm-hybrid/1 event batches.
//
// Device-authenticated (x-hybrid-device + x-hybrid-key, constant-time). A
// peer device pushes up to 200 outbox events; each is ingested via the ONE
// shared policy engine (ingestRemoteEvent — the same code the local pull
// cycle uses), so duplicate deliveries are absorbed and per-entity conflict
// policy always applies. Events are NEVER silently dropped:
//  - acked     → processed (applied, duplicate no-op, or a recorded conflict
//                decision — the sender marks them acked and stops retrying)
//  - rejected  → permanently invalid (unknown entity / malformed) with a
//                reason; the sender parks them as 'dead'
//  - neither   → the receiver could not apply (e.g. FK parent missing) — the
//                sender retries in a later batch
import { NextRequest, NextResponse } from 'next/server'

import { errorResponse } from '@/lib/auth'
import { requireDevice } from '@/lib/hybrid-auth'
import { db } from '@/lib/db'
import { ingestRemoteEvent, type RemoteEvent } from '@/lib/hybrid-sync/apply-remote-event'
import { resolvePolicy } from '@/lib/hybrid-sync/entity-policy'
import { HYBRID_PUSH_MAX_EVENTS } from '@/lib/hybrid-sync/constants'

export async function POST(req: NextRequest) {
  try {
    const device = await requireDevice(req)
    if (!device) {
      return NextResponse.json({ error: 'Unauthorized: valid device credentials required' }, { status: 401 })
    }

    const body: unknown = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const { events } = body as { events?: unknown }
    if (!Array.isArray(events)) {
      return NextResponse.json({ error: 'events must be an array' }, { status: 400 })
    }
    if (events.length === 0) {
      return NextResponse.json({ acked: [], rejected: [], conflicts: [] })
    }
    if (events.length > HYBRID_PUSH_MAX_EVENTS) {
      return NextResponse.json({ error: 'batch too large' }, { status: 429 })
    }

    const acked: string[] = []
    const rejected: Array<{ eventId: string; reason: string }> = []
    const conflicts: Array<{ eventId: string; entity: string; entityId: number; resolution: string }> = []

    for (const raw of events) {
      const evt = raw as Partial<RemoteEvent>
      const eventId = typeof evt.eventId === 'string' ? evt.eventId : ''

      // shape validation — malformed events are permanently rejected
      if (
        !eventId ||
        typeof evt.deviceId !== 'string' ||
        typeof evt.entity !== 'string' ||
        !Number.isInteger(evt.entityId) ||
        (evt.entityId as number) <= 0 ||
        typeof evt.operation !== 'string' ||
        !['create', 'update', 'delete'].includes(evt.operation) ||
        !Number.isInteger(evt.revision) ||
        (evt.revision as number) < 1 ||
        typeof evt.payloadHash !== 'string' ||
        !evt.payload ||
        typeof evt.payload !== 'object' ||
        Array.isArray(evt.payload)
      ) {
        rejected.push({ eventId: eventId || '(missing)', reason: 'malformed' })
        continue
      }

      // unknown entities are permanently rejected (typo / newer peer schema) —
      // NOT recorded as conflicts: there is nothing to reconcile against
      if (resolvePolicy(evt.entity) === null) {
        rejected.push({ eventId, reason: 'unknown-entity' })
        continue
      }

      const result = await ingestRemoteEvent({
        eventId,
        deviceId: evt.deviceId as string,
        entity: evt.entity as string,
        entityId: evt.entityId as number,
        operation: evt.operation as string,
        revision: evt.revision as number,
        payloadHash: evt.payloadHash as string,
        payload: evt.payload as Record<string, unknown>,
      })

      if (result.outcome === 'failed') {
        // not acked, not rejected — the sender retries once the blocker
        // (usually a missing FK parent) has arrived on this side
        continue
      }
      acked.push(eventId)
      if (result.outcome === 'conflict') {
        conflicts.push({
          eventId,
          entity: evt.entity as string,
          entityId: evt.entityId as number,
          resolution: result.resolution ?? 'recorded',
        })
      }
    }

    await db.hybridDevice.update({
      where: { id: device.id },
      data: { lastPushAt: new Date() },
    })

    return NextResponse.json({ acked, rejected, conflicts })
  } catch (err) {
    return errorResponse(err)
  }
}
