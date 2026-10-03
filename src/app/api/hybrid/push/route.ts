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
import { ingestRemoteEvent, retryInEvent, type RemoteEvent } from '@/lib/hybrid-sync/apply-remote-event'
import { resolvePolicy } from '@/lib/hybrid-sync/entity-policy'
import { emitOutboxEvent } from '@/lib/hybrid-sync/outbox'
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
    // r35 local-hub echo: events whose business write LANDED here and must
    // be carried on to the cloud hub (local SQLite plane only — see below).
    const appliedForEcho: Array<{
      entity: string
      entityId: number
      operation: 'create' | 'update' | 'delete'
      payload: Record<string, unknown>
    }> = []

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
      if (
        result.outcome === 'applied' ||
        (result.outcome === 'conflict' && result.applied)
      ) {
        appliedForEcho.push({
          entity: evt.entity as string,
          entityId: evt.entityId as number,
          operation: evt.operation as 'create' | 'update' | 'delete',
          payload: evt.payload as Record<string, unknown>,
        })
      }
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

    // r35 LOCAL HUB ECHO — when a LOCAL SQLite instance acts as a device's
    // apply target (the download-origin failover path), a device-pushed
    // event applied here would otherwise stay local-only: this instance's
    // pull stream never serves its own writes, and nothing else carries the
    // applied row to the cloud. Re-emit every landed write as an outbox
    // event so the engine pushes it to the hub (Neon) like any local POS
    // write. On the CLOUD data plane (Vercel/Neon) the apply IS the cloud
    // write — echoing there would double-push, so it is skipped.
    // Best-effort by design: the local row is already applied and the
    // sender was acked; an echo failure must not fail the response.
    if (appliedForEcho.length > 0 && process.env.DATABASE_URL?.startsWith('file:')) {
      for (const evt of appliedForEcho) {
        try {
          await emitOutboxEvent(db, {
            entity: evt.entity,
            entityId: evt.entityId,
            operation: evt.operation,
            row: evt.payload,
          })
        } catch {
          // best-effort — see note above
        }
      }
    }

    // p21: APPLY-SIDE SELF-HEALING — this instance (the cloud, or any peer
    // acting as an apply target) retries a few of its OWN previously-failed
    // in-events on every push. Until now a failed in-event here had NO retry
    // path (the local pull cycle only heals LOCAL in-events), so an FK parent
    // that arrived after the first attempt left the event stuck 'failed'
    // forever while the sender had already been acked on a later duplicate.
    // Bounded to 25 events/push, honoring the attempts budget inside
    // retryInEvent — terminal pushes are frequent, so queues drain fast.
    let healed = 0
    try {
      const parked = await db.hybridEvent.findMany({
        where: { direction: 'in', status: 'failed' },
        orderBy: { id: 'asc' },
        take: 25,
      })
      for (const row of parked) {
        const result = await retryInEvent(row)
        if (result.outcome !== 'failed') healed++
      }
    } catch {
      // healing is best-effort — never fail the push response over it
    }

    return NextResponse.json({ acked, rejected, conflicts, healed })
  } catch (err) {
    return errorResponse(err)
  }
}
