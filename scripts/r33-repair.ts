/**
 * r33 REPAIR v2 — converge local ↔ Neon after the r32-cleanup + FK-root drift.
 * (v1 aborted at first ingest: entityId must be Number; found item-1505
 * collision + the p20 order-1210 item gap — see header of v1 + worklog.)
 *
 * Divergence ledger (all six orders + products + items):
 *  D1 Developer account id: local 4 / Neon 14        → S1 renumber 14→4
 *  D2 Order 1216 + item 1512 + payments 218/219: Neon-only (r32 cleanup)
 *                                                     → pull via ingest
 *  D3 Products 226-229 (Lelo menu): Neon-only         → pull via ingest
 *  D4 Order 1210's ITEM: Neon id 1505, local MISSING (p20 recovery queried
 *     OrderItem entityId=1210 — the ORDER id — so the item event never came)
 *                                                     → S3 renumber Neon
 *                                                       1505→1513, pull
 *                                                       remapped, THEN
 *                                                       local 1505 (order
 *                                                       1211's) pushes clean
 *  D5 Orders 1211/1214/1215 + items 1505/1509/1510/1511 + payments 216/217:
 *     local-only (died fk-parent-missing on Neon — D1 root cause)
 *                                                     → touch-repair push
 *  D6 Order 40: local paid (Oct 3) vs Neon open (Oct 2, dead-terminal origin)
 *                                                     → S2 surgical unblock
 *                                                       + touch-repair
 *  D7 Order 328: local paid (Oct 3) vs Neon deferred (Sep 30, no origin)
 *                                                     → touch-repair
 *
 * Surgical writes — three, all documented in the worklog:
 *   S1 Neon users 14 → 4          (zero FK references to 14)
 *   S2 Neon orders 40 open→paid   (dead-terminal guard unblock)
 *   S3 Neon order_items 1505→1513 (zero inbound FKs on order_items; aligns
 *                                  the item-id space so every logical item
 *                                  shares ONE id on both sides)
 * Everything else rides the DESIGNED channels: ingestRemoteEvent + emitOutboxEvent.
 */
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { db } from '../src/lib/db'
import { emitOutboxEvent } from '../src/lib/hybrid-sync/outbox'
import { ingestRemoteEvent, type RemoteEvent } from '../src/lib/hybrid-sync/apply-remote-event'

function neonUrl(): string {
  const vault = readFileSync('/home/z/my-project/.git/env-vault.env', 'utf8')
  return vault.match(/^NEON_DATABASE_URL=(.+)$/m)![1].trim().replace(/^["']|["']$/g, '')
}

const money = (n: number | null | undefined) => `EGP ${Number(n ?? 0).toFixed(2)}`

function toEvent(r: Record<string, unknown>, idOverride?: number): RemoteEvent {
  const payload = JSON.parse(String(r.payload)) as Record<string, unknown>
  if (idOverride !== undefined) payload.id = idOverride
  return {
    eventId: String(r.eventId),
    deviceId: String(r.deviceId),
    entity: String(r.entity),
    entityId: idOverride ?? Number(r.entityId),
    operation: String(r.operation) as RemoteEvent['operation'],
    revision: Number(r.revision),
    payloadHash: idOverride !== undefined ? `remap-${idOverride}-${r.payloadHash}`.slice(0, 64) : String(r.payloadHash),
    payload,
  }
}

async function ingest(events: Array<Record<string, unknown>>, label: string, idOverride?: number) {
  for (const r of events) {
    const out = await ingestRemoteEvent(toEvent(r, idOverride))
    console.log(`  ${label} cloud#${r.id} ${r.entity}/${idOverride ?? r.entityId} ${r.operation} rev=${r.revision} → ${out.outcome}${out.reason ? ` (${out.reason})` : ''}${out.resolution ? ` [${out.resolution}]` : ''}`)
  }
}

async function main() {
  const pool = new pg.Pool({ connectionString: neonUrl(), ssl: { rejectUnauthorized: false }, max: 2 })

  // ── PHASE 0 · preflight ────────────────────────────────────────────────
  console.log('=== PHASE 0 · preflight ===')
  const pre = await pool.query(`SELECT
    (SELECT COUNT(*)::int FROM orders) o,
    (SELECT COUNT(*)::int FROM payments) p,
    (SELECT COUNT(*)::int FROM products) pr,
    (SELECT COUNT(*)::int FROM users WHERE id = 4) u4,
    (SELECT COUNT(*)::int FROM users WHERE id = 14) u14,
    (SELECT COUNT(*)::int FROM order_items WHERE id = 1513) i1513`)
  const n = pre.rows[0]
  console.log(`  Neon: orders=${n.o} payments=${n.p} products=${n.pr} user4=${n.u4} user14=${n.u14} item1513=${n.i1513}`)
  if (!((n.u4 === 1 && n.u14 === 0) || (n.u4 === 0 && n.u14 === 1))) {
    console.log('  ✗ unexpected user id state — aborting'); process.exit(1)
  }
  // inbound FK check on order_items (for S3)
  const fk = await pool.query(`SELECT conrelid::regclass tbl FROM pg_constraint WHERE confrelid = 'order_items'::regclass AND contype = 'f'`)
  console.log(`  inbound FKs on order_items: ${fk.rows.length ? fk.rows.map((r: any) => r.tbl).join(', ') : 'NONE (S3 safe)'}`)
  if (fk.rows.length > 0) { console.log('  ✗ order_items has inbound FKs — S3 unsafe, aborting'); process.exit(1) }
  const lpre = await db.$transaction(async () => ({
    o: await db.order.count(), p: await db.payment.count(), pr: await db.product.count(),
  }))
  console.log(`  Local: orders=${lpre.o} payments=${lpre.p} products=${lpre.pr}`)

  // ── PHASE 1 · S1 surgical: Neon user 14 → 4 (idempotent) ──────────────
  if (n.u14 === 1) {
    console.log('=== PHASE 1 · S1 surgical — Neon users 14 → 4 ===')
    await pool.query(`UPDATE users SET id = 4 WHERE id = 14`)
    const u = await pool.query(`SELECT id, name FROM users WHERE id = 4`)
    console.log(`  ✓ Developer now id=4 on Neon (${u.rows[0]?.name})`)
  } else {
    console.log('=== PHASE 1 · S1 already applied (user 4 present) — skipping ===')
  }

  // ── PHASE 2 · pulls to local (designed ingest channel) ────────────────
  console.log('=== PHASE 2 · pulls to local ===')

  // 2a — order #1216 graph: Order events → item 1512 → payments 218/219
  {
    const g = await pool.query(`SELECT * FROM hybrid_events
      WHERE (entity='Order' AND "entityId"='1216') OR (entity='OrderItem' AND "entityId"='1512') OR (entity='Payment' AND "entityId" IN ('218','219'))
      ORDER BY CASE WHEN entity='Order' THEN 0 WHEN entity='OrderItem' THEN 1 ELSE 2 END, revision, id`)
    await ingest(g.rows, '1216')
    const o = await db.order.findUnique({ where: { id: 1216 }, select: { status: true, totalAmount: true } })
    const it = await db.orderItem.findMany({ where: { orderId: 1216 }, select: { id: true } })
    const pay = await db.payment.findMany({ where: { orderId: 1216 }, select: { amount: true } })
    console.log(`  → local #1216: ${o?.status ?? 'MISSING'} ${money(o?.totalAmount)} items=${it.length} payments=[${pay.map(p => p.amount).join(', ')}]`)
  }

  // 2b — products 226-229 (Lelo menu) via their Neon events
  {
    const g = await pool.query(`SELECT * FROM hybrid_events WHERE entity='Product' AND "entityId" IN ('226','227','228','229') ORDER BY "entityId", revision, id`)
    if (g.rows.length > 0) await ingest(g.rows, 'product')
    else {
      console.log('  no Neon events for products 226-229 — synthesizing creates from rows')
      const rows = await pool.query(`SELECT * FROM products WHERE id IN (226,227,228,229) ORDER BY id`)
      for (const row of rows.rows) {
        const evt: RemoteEvent = {
          eventId: crypto.randomUUID(), deviceId: 'neon-direct-seed', entity: 'Product',
          entityId: Number(row.id), operation: 'create', revision: 1,
          payloadHash: `synth-${row.id}`, payload: row as Record<string, unknown>,
        }
        const out = await ingestRemoteEvent(evt)
        console.log(`  product #${row.id} (${row.name}) → ${out.outcome}${out.reason ? ` (${out.reason})` : ''}`)
      }
    }
    console.log(`  → local products now: ${await db.product.count()} (expect 303)`)
  }

  // 2c — S3 surgical renumber Neon item 1505 (order 1210's) → 1513, then
  //      pull order-1210's item events remapped to 1513 (local id 1505 is
  //      order 1211's — must not be clobbered)
  {
    console.log('=== PHASE 2c · S3 surgical — Neon item 1505 (order 1210) → 1513 ===')
    const chk = await pool.query(`SELECT id, order_id FROM order_items WHERE id IN (1505, 1513) ORDER BY id`)
    for (const r of chk.rows) console.log(`  Neon item ${r.id} → order ${r.order_id}`)
    const cur = await pool.query(`SELECT order_id FROM order_items WHERE id = 1505`)
    if (cur.rows.length && Number(cur.rows[0].order_id) === 1210) {
      await pool.query(`UPDATE order_items SET id = 1513 WHERE id = 1505`)
      console.log('  ✓ renumbered 1505 → 1513 on Neon')
    } else {
      console.log('  skip: Neon 1505 is not order 1210\'s (already renumbered?)')
    }
    const g = await pool.query(`SELECT * FROM hybrid_events WHERE entity='OrderItem' AND "entityId"='1505' ORDER BY revision, id`)
    if (g.rows.length > 0) await ingest(g.rows, 'item1210', 1513)
    else {
      console.log('  no events for item 1505 — synthesizing create from the Neon row (remapped 1513)')
      const row = await pool.query(`SELECT * FROM order_items WHERE id = 1513`)
      if (row.rows.length) {
        const evt: RemoteEvent = {
          eventId: crypto.randomUUID(), deviceId: 'neon-direct-seed', entity: 'OrderItem',
          entityId: 1513, operation: 'create', revision: 1,
          payloadHash: `synth-item-1513`, payload: row.rows[0] as Record<string, unknown>,
        }
        const out = await ingestRemoteEvent(evt)
        console.log(`  item 1513 (order 1210) → ${out.outcome}${out.reason ? ` (${out.reason})` : ''}`)
      }
    }
    const it1210 = await db.orderItem.findMany({ where: { orderId: 1210 }, select: { id: true, productId: true } })
    console.log(`  → local order 1210 items: ${JSON.stringify(it1210)}`)
  }

  // ── PHASE 3 · S2 surgical: unblock order #40 on Neon (idempotent) ─────
  {
    const st = await pool.query(`SELECT status FROM orders WHERE id = 40`)
    if (st.rows.length && st.rows[0].status === 'open') {
      console.log('=== PHASE 3 · S2 surgical — Neon order #40 open → paid ===')
      const l40 = await db.order.findUnique({ where: { id: 40 }, select: { closedAt: true, updatedAt: true } })
      const upd = await pool.query(
        `UPDATE orders SET status='paid', closed_at=$1, updated_at=$2 WHERE id=40 AND status='open' RETURNING status`,
        [l40?.closedAt ?? new Date(), l40?.updatedAt ?? new Date()])
      console.log(`  ✓ Neon #40 → ${upd.rows[0]?.status} (guard unblocked — dead terminal 413e1476)`)
    } else {
      console.log('=== PHASE 3 · Neon #40 not open — skipping ===')
    }
  }

  // ── PHASE 4 · touch-repair emissions (designed push channel, rev+1) ───
  console.log('=== PHASE 4 · touch-repair outbox emissions ===')
  for (const id of [40, 328, 1211, 1214, 1215]) {
    const row = await db.$transaction(async (tx) => {
      const updated = await tx.order.update({ where: { id }, data: { updatedAt: new Date() } })
      await emitOutboxEvent(tx, { entity: 'Order', entityId: id, operation: 'update', row: updated })
      return updated
    })
    console.log(`  Order #${id}: rev+1 (status=${row.status}, ${money(row.totalAmount)})`)
  }
  for (const id of [1505, 1509, 1510, 1511]) {
    const row = await db.$transaction(async (tx) => {
      const updated = await tx.orderItem.update({ where: { id }, data: {} })
      await emitOutboxEvent(tx, { entity: 'OrderItem', entityId: id, operation: 'update', row: updated })
      return updated
    })
    console.log(`  Item #${id}: rev+1 (order=${row.orderId}, product=${row.productId})`)
  }
  for (const id of [216, 217]) {
    const row = await db.$transaction(async (tx) => {
      const p = await tx.payment.findUniqueOrThrow({ where: { id } })
      await emitOutboxEvent(tx, { entity: 'Payment', entityId: id, operation: 'create', row: p })
      return p
    })
    console.log(`  Payment #${id}: create re-emit (order=${row.orderId}, ${money(row.amount)})`)
  }
  const pend = await db.hybridEvent.count({ where: { direction: 'out', status: 'pending' } })
  console.log(`  outbox pending: ${pend} — engine pushes within 30s (or run sync-now)`)

  await pool.end()
  await db.$disconnect()
  console.log('=== r33 repair v2 complete — next: sync-now + parity verify ===')
}

main().catch((e) => { console.error('REPAIR FAILED:', e.message); process.exit(1) })
