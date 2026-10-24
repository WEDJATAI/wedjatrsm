/**
 * r70 audit — repair the two cross-plane divergences found by the parity scan.
 *
 * DIVERGENCE 1 (Order #2242 + Payments #307/#308 missing locally):
 *   Order #2242 was created on THIS terminal (originDeviceId 4680bc22) on
 *   Oct 18 and pushed to the cloud; a sandbox db recycle later lost the
 *   local rows. The pull stream's echo guard (deviceId != requester) means
 *   a terminal can never re-pull its OWN pushed events, so the cloud's
 *   copies were unreachable — permanent gap. Repair: replay the exact
 *   payloads from Neon's own event log through the real guarded ingest path
 *   (fresh documented eventIds, original revisions) — create → payments →
 *   terminal update. Net financial effect: zero (189.00 − 189.00 refund;
 *   the check was cancelled after close).
 *
 * DIVERGENCE 2 (Payment #314 orderId stuck on the merged-away #2249):
 *   During the Oct 23 merge of #2249 into #2246 the desktop re-parented
 *   payment #314; the local plane processed that event at 13:26:45 — BEFORE
 *   the r68 heal merged #2249 locally (14:01) — so the isPaymentReParent
 *   guard (parent must already be 'merged') rejected it (conflict #2881,
 *   append-only, rejected) and the acked event never retried. Repair: replay
 *   the re-parent update now (parent #2249 IS merged locally today), with
 *   the byte-identical payload from the cloud row — only orderId differs.
 *
 * Idempotent: every replay is deduped by fresh eventIds; already-converged
 * rows are detected and skipped. Plane: LOCAL only (the cloud is the source
 * of truth for these rows).
 */
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'

import { db } from '../../src/lib/db'
import { ingestRemoteEvent } from '../../src/lib/hybrid-sync/apply-remote-event'
import { canonicalJson, sha256Hex } from '../../src/lib/hybrid-sync/serialization'
import { neonPooledUrl } from '../lib/env-local'

type Evt = {
  eventId: string
  deviceId: string
  entity: string
  entityId: number
  operation: string
  revision: number
  payloadHash: string
  payload: Record<string, unknown>
}

async function main() {
  const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false } })

  const replay = async (evt: Evt, label: string) => {
    const result = await ingestRemoteEvent(evt)
    console.log(
      `  ${label}: ${result.outcome}${result.reason ? ` (${result.reason})` : ''}${result.resolution ? ` [${result.resolution}]` : ''}`,
    )
    return result.outcome
  }

  // ── DIVERGENCE 1: order #2242 + payments #307/#308 ──
  const local2242 = await db.order.findUnique({ where: { id: 2242 } })
  if (!local2242) {
    console.log('D1: order #2242 missing locally — replaying from the cloud event log')
    const rows = (
      await pool.query(
        'SELECT id, entity, "entityId", operation, revision, payload, "deviceId" FROM hybrid_events WHERE id IN (16993, 17005, 17010, 17011) ORDER BY id',
      )
    ).rows as Array<{
      id: number
      entity: string
      entityId: number
      operation: string
      revision: number
      payload: string
      deviceId: string
    }>
    if (rows.length !== 4) throw new Error(`expected 4 source events on Neon, got ${rows.length}`)
    for (const r of rows) {
      const payload = JSON.parse(r.payload) as Record<string, unknown>
      await replay(
        {
          eventId: `r70-heal-${r.entity}-${r.entityId}-${randomUUID().slice(0, 8)}`,
          deviceId: r.deviceId,
          entity: r.entity,
          entityId: r.entityId,
          operation: r.operation,
          revision: r.revision,
          payloadHash: sha256Hex(canonicalJson(payload)),
          payload,
        },
        `${r.entity}/${r.entityId} ${r.operation} (neon evt ${r.id})`,
      )
    }
    const after = await db.order.findUnique({ where: { id: 2242 }, include: { payments: true } })
    console.log(
      `D1 RESULT: order #2242 → ${after?.status}, total ${after?.totalAmount}, payments ${after?.payments.map((p) => `${p.id}:${p.amount}`).join(' ') || 'NONE'}`,
    )
  } else {
    console.log(`D1: order #2242 already present locally (status ${local2242.status}) — skipped`)
  }

  // ── DIVERGENCE 2: payment #314 re-parent ──
  const local314 = await db.payment.findUnique({ where: { id: 314 } })
  if (local314 && local314.orderId === 2249) {
    console.log('D2: payment #314 still parented to merged-away #2249 — replaying the re-parent')
    const parent = await db.order.findUnique({ where: { id: 2249 }, select: { status: true } })
    if (parent?.status !== 'merged') throw new Error(`guard precondition failed: order #2249 local status is ${parent?.status}, expected merged`)
    const nRow = (
      await pool.query('SELECT id, order_id, method, amount, tip, reference, amount_tendered, change_given, created_at FROM payments WHERE id = 314')
    ).rows[0] as {
      id: number
      order_id: number
      method: string
      amount: number
      tip: number
      reference: string
      amount_tendered: number
      change_given: number
      created_at: string
    }
    const payload = {
      id: nRow.id,
      orderId: nRow.order_id,
      method: nRow.method,
      amount: nRow.amount,
      tip: nRow.tip,
      reference: nRow.reference,
      amountTendered: nRow.amount_tendered,
      changeGiven: nRow.change_given,
      createdAt: new Date(nRow.created_at).toISOString(),
    }
    // byte-identical to the local row EXCEPT orderId — verify before replay
    const lRow = local314 as unknown as Record<string, unknown>
    for (const [k, v] of Object.entries(payload)) {
      if (k === 'orderId') continue
      const lv = lRow[k]
      if (lv instanceof Date ? lv.toISOString() !== v : lv !== v) {
        throw new Error(`payload mismatch on ${k}: local=${JSON.stringify(lv)} cloud=${JSON.stringify(v)} — refusing to replay`)
      }
    }
    const mergeDevice = 'a569b12a-35a6-4ca7-8f74-a1903eda74ac' // the desktop that performed the merge
    await replay(
      {
        eventId: `r70-heal-Payment-314-${randomUUID().slice(0, 8)}`,
        deviceId: mergeDevice,
        entity: 'Payment',
        entityId: 314,
        operation: 'update',
        revision: 2,
        payloadHash: sha256Hex(canonicalJson(payload)),
        payload,
      },
      'Payment/314 update (re-parent 2249 → 2246)',
    )
    const after = await db.payment.findUnique({ where: { id: 314 } })
    console.log(`D2 RESULT: payment #314 orderId → ${after?.orderId} (expected 2246)`)
  } else if (local314) {
    console.log(`D2: payment #314 already converged (orderId ${local314.orderId}) — skipped`)
  } else {
    console.log('D2: payment #314 missing locally — unexpected, skipped (needs review)')
  }

  await pool.end()
  await db.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
