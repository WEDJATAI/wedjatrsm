/**
 * r68 — heal the cross-plane stuck checks.
 *
 * ROOT CAUSE (the owner complaint "the takeaway doesn't connect to my shift"):
 * the hybrid origin-authority guard rejected every Order-row update that a
 * NON-origin plane made while the check was open — including the legitimate
 * PAYMENT CLOSE. A takeaway paid on another terminal/desktop stayed 'open'
 * forever on every other plane while its Payment rows (append-only) synced
 * fine. Live evidence: #2235 #2243 #2248 #2249 #2251 — all fully paid (or
 * cancelled/merged later), all stuck open locally.
 *
 * THE FIX ships in src/lib/hybrid-sync/apply-remote-event.ts (r68 guard
 * exemptions: latest-action-wins-by-timestamp + terminal money convergence).
 * This script REPLAYS each stuck check's authoritative terminal payload
 * THROUGH the real production ingest path (ingestRemoteEvent with a fresh
 * documented eventId and revision = localMax+1), so the repair itself proves
 * the guard fix on live data. The re-ingested events carry the exact row
 * state from the closing plane (status/closedAt/updatedAt preserved — no
 * fake "closed now" timestamps).
 *
 * Additionally the r68 SETTLE-CLAIM is applied to #2251: a check OPENED
 * BEFORE TODAY that was settled TODAY by a different server becomes the
 * settling server's shift work (Amira paid Karim's Oct-22 takeaway today —
 * the audit row user=13 proves the closer). The claim is a normal local
 * business write + outbox event, so the cloud and the desktop converge on
 * the attribution.
 *
 * Run (local plane):   bun scripts/r68/heal-stuck-checks.ts
 * Run (cloud plane):   DATABASE_URL=<neon-postgres-url> bun scripts/r68/heal-stuck-checks.ts
 *   — plane-agnostic: every query + the ingest + the claim write go through
 *     @/lib/db, which picks the SQLite or Postgres adapter from DATABASE_URL
 *     (the r68 guard fix must run on the plane being healed). Idempotent:
 *     planes with no stuck checks are a clean no-op.
 */
import { randomUUID } from 'node:crypto'

import { db } from '../../src/lib/db'
import { ingestRemoteEvent } from '../../src/lib/hybrid-sync/apply-remote-event'
import { emitOutboxEvent } from '../../src/lib/hybrid-sync/outbox'
import { canonicalJson, sha256Hex } from '../../src/lib/hybrid-sync/serialization'

const TERMINAL = new Set(['paid', 'cancelled', 'merged'])

async function main() {
  const isCloud = !(process.env.DATABASE_URL ?? '').startsWith('file:')
  console.log(`heal-stuck-checks — plane: ${isCloud ? 'CLOUD (Postgres)' : 'LOCAL (SQLite)'}`)
  try {
    // 1. find stuck checks: non-terminal locally, payments cover the total
    const stuck = await db.order.findMany({
      where: { status: { in: ['open', 'deferred'] } },
      select: {
        id: true, status: true, orderType: true, userId: true, totalAmount: true,
        createdAt: true, updatedAt: true, payments: { select: { amount: true } },
      },
      orderBy: { id: 'asc' },
    })
    const fullyPaid = stuck.filter(
      (o) => o.payments.reduce((s, p) => s + p.amount, 0) >= o.totalAmount - 0.01,
    )
    console.log(`stuck open/deferred checks with full payments: ${fullyPaid.map((o) => `#${o.id}`).join(', ') || 'none'}`)

    let healed = 0
    let claimed = 0
    for (const order of fullyPaid) {
      // 2. the authoritative terminal payload = the highest-revision in-event
      //    whose row status is terminal (the closing plane's exact state)
      const events = await db.hybridEvent.findMany({
        where: { entity: 'Order', entityId: order.id, direction: 'in' },
        orderBy: [{ revision: 'desc' }, { id: 'desc' }],
      })
      let authoritative: { revision: number; payload: Record<string, unknown>; deviceId: string } | null = null
      for (const ev of events) {
        try {
          const payload = JSON.parse(ev.payload) as Record<string, unknown>
          if (TERMINAL.has(String(payload.status))) {
            authoritative = { revision: ev.revision, payload, deviceId: ev.deviceId }
            break
          }
        } catch {
          /* skip unparseable */
        }
      }
      if (!authoritative) {
        console.log(`  #${order.id}: NO terminal payload in the local event log — SKIPPED (needs manual review)`)
        continue
      }

      // 3. re-ingest through the REAL guarded path (fresh eventId, next
      //    revision) — with the r68 guard exemptions this applies
      const maxRev = events[0]?.revision ?? 0
      const evt = {
        eventId: `r68-heal-${order.id}-${randomUUID().slice(0, 8)}`,
        deviceId: authoritative.deviceId,
        entity: 'Order',
        entityId: order.id,
        operation: 'update',
        revision: maxRev + 1,
        payloadHash: sha256Hex(canonicalJson(authoritative.payload)),
        payload: authoritative.payload,
      }
      const result = await ingestRemoteEvent(evt)
      if (result.outcome !== 'applied') {
        console.log(
          `  #${order.id}: ingest NOT applied (outcome=${result.outcome} reason=${result.reason ?? ''} resolution=${result.resolution ?? ''}) — SKIPPED`,
        )
        continue
      }
      healed++
      console.log(
        `  #${order.id}: healed → ${String(authoritative.payload.status)} (rev ${evt.revision}, closedAt ${String(authoritative.payload.closedAt ?? '—')})`,
      )

      // 4. the r68 SETTLE-CLAIM on top: an old check (created before the close
      //    day) settled by a DIFFERENT server belongs in the closer's shift
      //    (only for PAID checks — merged/cancelled rows are excluded from
      //    My shift anyway). The closer is proven by the audit row of the
      //    settling payment.
      const closedAt = authoritative.payload.closedAt
      const closeDay = closedAt ? new Date(String(closedAt)) : null
      const createdDay = new Date(order.createdAt)
      if (closeDay && authoritative.payload.status === 'paid') {
        const sameLocalDay =
          closeDay.getFullYear() === createdDay.getFullYear() &&
          closeDay.getMonth() === createdDay.getMonth() &&
          closeDay.getDate() === createdDay.getDate()
        if (!sameLocalDay) {
          const audit = await db.auditLog.findFirst({
            where: { action: 'order.payment', entityId: order.id },
            orderBy: { id: 'desc' },
            select: { userId: true, createdAt: true },
          })
          if (audit?.userId != null && audit.userId !== authoritative.payload.userId) {
            const newUserId = await db.$transaction(async (tx) => {
              const row = await tx.order.update({
                where: { id: order.id },
                data: { userId: audit.userId },
              })
              await emitOutboxEvent(tx, {
                entity: 'Order',
                entityId: order.id,
                operation: 'update',
                row,
              })
              return row.userId
            })
            claimed++
            console.log(
              `  #${order.id}: SETTLE-CLAIM userId ${String(authoritative.payload.userId)} → ${newUserId} (closed ${closeDay.toISOString().slice(0, 10)} by the audit-proven closer, created ${createdDay.toISOString().slice(0, 10)})`,
            )
          }
        }
      }
    }

    console.log(`\nhealed ${healed} check(s) · settle-claimed ${claimed}`)
    // 5. verify no stuck checks remain
    const remaining = await db.order.findMany({
      where: { status: { in: ['open', 'deferred'] } },
      select: { id: true, totalAmount: true, payments: { select: { amount: true } } },
    })
    const still = remaining.filter((o) => o.payments.reduce((s, p) => s + p.amount, 0) >= o.totalAmount - 0.01)
    console.log(`still stuck after heal: ${still.map((o) => `#${o.id}`).join(', ') || 'NONE'}`)
  } finally {
    await db.$disconnect()
  }
}

main().catch((err) => {
  console.error('heal-stuck-checks failed:', err)
  process.exit(1)
})
