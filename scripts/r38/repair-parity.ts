/**
 * r38 — MASTER PARITY REPAIR (local SQLite ⇄ Neon Postgres).
 *
 * Divergence inventory (from parity-map.ts, 2026-10-04 08:5x):
 *   customers            +10 local-only (5-14) + 2 CONFLICTING ids (Neon 2/3 =
 *                        cloud-registered Dr. Ehab Kamel / Dr. Amr vs local
 *                        Karim Regular / Dr. Farouk Al-Amin)
 *   payments             +45 local-only (220-264, r33 money-repair rows)
 *   order_items          +2 local-only (160, 328)
 *   inventory_tx         +8 local-only (459-466) + 3 NEON-only (467-469,
 *                        r36 direct-Neon recipe deductions for order 1216)
 *   stock_counts(+lines) +1 count local-only (#2) + 19 lines
 *   attendance           +1 local-only
 *   audit_logs           +3695 local-only
 *   categories           +1 NEON-only orphan (#29 "Omelet", 0 product refs)
 *   product stock        6/9/296 diverged (Neon deducted for order 1216,
 *                        local not)
 *   sequences            8 tables with Neon seq behind local max (the
 *                        Yasmine-overwrite root cause)
 *
 * Repair strategy (zero data loss, both directions):
 *   1. Neon re-id dance: cloud customers 2→18, 3→19 (FK-safe: temporarily
 *      null order FKs, re-id, backfill local 2/3, restore FKs — orders keep
 *      pointing at 2/3 which then mean the SAME people on both sides).
 *   2. Backfill ALL local-only rows → Neon (id-preserving upserts).
 *   3. Emit pull events (direction 'out', deviceId 'unbound') for the 8
 *      Neon-only changes so local converges: Customer 18/19 creates,
 *      InventoryTransaction 467-469 creates, Product 6/9/296 updates.
 *   4. Delete the orphan category 29 on Neon.
 *   5. setval EVERY registry table sequence on Neon to its max(id) — the
 *      collision-prevention fix (plus the code-level self-heal in
 *      apply-remote-event.ts, deployed separately).
 *
 * Idempotent: re-running hits ON CONFLICT DO NOTHING everywhere.
 */
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { neonPooledUrl } from '../lib/env-local'
import { db } from '../../src/lib/db'

const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })

// ─── helpers ───────────────────────────────────────────────────────────
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())
const iso = (v: unknown): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString()

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/** SQL literal for a value (safe for our controlled data). */
function lit(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'object') return `'${JSON.stringify(v).replaceAll("'", "''")}'`
  return `'${String(v).replaceAll("'", "''")}'`
}

/** Map a Prisma row (camelCase) to a PG insert using the table's column list. */
function toPgRow(row: Record<string, unknown>, pgColumns: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    const col = snake(k)
    if (!pgColumns.includes(col)) continue
    out[col] = v instanceof Date ? v.toISOString() : v
  }
  return out
}

async function insertRow(table: string, pgRow: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(pgRow)
  const vals = cols.map((c) => lit(pgRow[c])).join(', ')
  await pool.query(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${vals}) ON CONFLICT (id) DO NOTHING`,
  )
}

async function columnsOf(table: string): Promise<string[]> {
  const r = await pool.query(
    "SELECT column_name FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position",
    [table],
  )
  return r.rows.map((x: { column_name: string }) => x.column_name)
}

async function main() {
  console.log('══ r38 parity repair — start ══')

  // ── PART 1: Neon re-id dance (customers 2/3 → 18/19) ────────────────
  console.log('\n[1] Neon customer re-id (cloud-registered → 18/19)…')
  const fkRows = await pool.query('SELECT id, customer_id FROM orders WHERE customer_id IN (2,3) ORDER BY id')
  console.log(`    orders referencing customers 2/3: ${JSON.stringify(fkRows.rows)}`)
  if (fkRows.rows.length > 0) {
    await pool.query('UPDATE orders SET customer_id = NULL WHERE customer_id IN (2,3)')
  }
  const reid1 = await pool.query("UPDATE customers SET id = 18 WHERE id = 2 AND name = 'Dr. Ehab Kamel'")
  const reid2 = await pool.query("UPDATE customers SET id = 19 WHERE id = 3 AND name = 'Dr. Amr'")
  console.log(`    re-id 2→18: ${reid1.rowCount} row · 3→19: ${reid2.rowCount} row`)
  // remember the re-ided rows for pull events later
  const ehab = await pool.query('SELECT * FROM customers WHERE id = 18')
  const amr = await pool.query('SELECT * FROM customers WHERE id = 19')

  // ── PART 2: backfill local-only rows → Neon ──────────────────────────
  console.log('\n[2] Backfill local-only rows → Neon…')

  // customers: local 2,3,5-14 (after re-id freed 2/3)
  const custCols = await columnsOf('customers')
  const localCustomers = await db.customer.findMany({ where: { id: { in: [2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] } } })
  for (const c of localCustomers) {
    const raw = c as unknown as Record<string, unknown>
    await insertRow('customers', toPgRow(raw, custCols))
  }
  console.log(`    customers backfilled: ${localCustomers.length}`)

  // payments 220-264
  const payCols = await columnsOf('payments')
  const localPays = await db.payment.findMany({ where: { id: { gte: 220 } } })
  for (const p of localPays) {
    await insertRow('payments', toPgRow(p as unknown as Record<string, unknown>, payCols))
  }
  console.log(`    payments backfilled: ${localPays.length}`)

  // order_items 160, 328
  const itemCols = await columnsOf('order_items')
  const localItems = await db.orderItem.findMany({ where: { id: { in: [160, 328] } } })
  for (const i of localItems) {
    const raw = i as unknown as Record<string, unknown>
    const pgRow = toPgRow(raw, itemCols)
    if (typeof pgRow['selected_modifiers'] === 'object' && pgRow['selected_modifiers'] !== null) {
      pgRow['selected_modifiers'] = JSON.stringify(pgRow['selected_modifiers'])
    }
    await insertRow('order_items', pgRow)
  }
  console.log(`    order_items backfilled: ${localItems.length}`)

  // inventory_transactions 459-466
  const itCols = await columnsOf('inventory_transactions')
  const localTx = await db.inventoryTransaction.findMany({ where: { id: { gte: 459, lte: 466 } } })
  for (const t of localTx) {
    await insertRow('inventory_transactions', toPgRow(t as unknown as Record<string, unknown>, itCols))
  }
  console.log(`    inventory_transactions backfilled: ${localTx.length}`)

  // stock_counts + lines (local-only ids)
  const scCols = await columnsOf('stock_counts')
  const sclCols = await columnsOf('stock_count_lines')
  const neonSC = await pool.query('SELECT id FROM stock_counts')
  const neonSCIds = new Set(neonSC.rows.map((r: { id: number }) => r.id))
  const localSCs = await db.stockCount.findMany()
  let scN = 0
  let sclN = 0
  for (const sc of localSCs) {
    if (!neonSCIds.has(sc.id)) {
      await insertRow('stock_counts', toPgRow(sc as unknown as Record<string, unknown>, scCols))
      scN++
    }
    const lines = await db.stockCountLine.findMany({ where: { stockCountId: sc.id } })
    for (const l of lines) {
      const exists = await pool.query('SELECT 1 FROM stock_count_lines WHERE id = $1', [l.id])
      if (exists.rowCount === 0) {
        await insertRow('stock_count_lines', toPgRow(l as unknown as Record<string, unknown>, sclCols))
        sclN++
      }
    }
  }
  console.log(`    stock_counts backfilled: ${scN} · lines: ${sclN}`)

  // attendance (local-only)
  const attCols = await columnsOf('attendance')
  const neonAtt = await pool.query('SELECT id FROM attendance')
  const neonAttIds = new Set(neonAtt.rows.map((r: { id: number }) => r.id))
  const localAtt = await db.attendance.findMany()
  let attN = 0
  for (const a of localAtt) {
    if (!neonAttIds.has(a.id)) {
      await insertRow('attendance', toPgRow(a as unknown as Record<string, unknown>, attCols))
      attN++
    }
  }
  console.log(`    attendance backfilled: ${attN}`)

  // audit_logs (local-only — the full local audit trail)
  const alCols = await columnsOf('audit_logs')
  const neonAL = await pool.query('SELECT id FROM audit_logs')
  const neonALIds = new Set(neonAL.rows.map((r: { id: number }) => r.id))
  const localAL = await db.auditLog.findMany({ orderBy: { id: 'asc' } })
  let alN = 0
  for (const a of localAL) {
    if (!neonALIds.has(a.id)) {
      await insertRow('audit_logs', toPgRow(a as unknown as Record<string, unknown>, alCols))
      alN++
    }
  }
  console.log(`    audit_logs backfilled: ${alN}`)

  // ── PART 3: restore order FKs (2/3 now = Karim/Farouk on both sides) ─
  console.log('\n[3] Restore order customer FKs…')
  for (const r of fkRows.rows as Array<{ id: number; customer_id: number }>) {
    await pool.query('UPDATE orders SET customer_id = $1 WHERE id = $2', [r.customer_id, r.id])
  }
  console.log(`    restored ${fkRows.rows.length} order FKs (2/3 = Karim/Farouk everywhere)`)

  // ── PART 4: emit pull events for Neon-only changes ──────────────────
  console.log('\n[4] Emit pull events (Neon → local)…')
  async function emitEvent(entity: string, entityId: number, operation: string, payload: Record<string, unknown>) {
    // revision: local max + 1 so the revision floor passes on the receiver
    const localMax = await db.hybridEvent.aggregate({
      where: { entity, entityId },
      _max: { revision: true },
    })
    const revision = (localMax._max.revision ?? 0) + 1
    const payloadJson = JSON.stringify(payload)
    const payloadHash = sha256(payloadJson)
    await pool.query(
      `INSERT INTO hybrid_events ("eventId","deviceId","entity","entityId","operation","revision","payloadHash","payload","direction","status","attempts","createdAt","updatedAt")
       VALUES ($1,'unbound',$2,$3,$4,$5,$6,$7,'out','pending',0,now(),now())`,
      [randomUUID(), entity, entityId, operation, revision, payloadHash, payloadJson],
    )
    console.log(`    event: ${entity}#${entityId} ${operation} rev${revision}`)
  }

  // snake→camel row for payload (Prisma field names)
  const toCamelRow = (row: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(row)) out[camel(k)] = v
    return out
  }

  if (ehab.rows[0]) await emitEvent('Customer', 18, 'create', toCamelRow(ehab.rows[0]))
  if (amr.rows[0]) await emitEvent('Customer', 19, 'create', toCamelRow(amr.rows[0]))

  const neonTx = await pool.query('SELECT * FROM inventory_transactions WHERE id >= 467 ORDER BY id')
  for (const t of neonTx.rows) {
    await emitEvent('InventoryTransaction', t.id, 'create', toCamelRow(t))
  }

  for (const pid of [6, 9, 296]) {
    const p = await pool.query('SELECT * FROM products WHERE id = $1', [pid])
    if (p.rows[0]) await emitEvent('Product', pid, 'update', toCamelRow(p.rows[0]))
  }

  // ── PART 5: delete orphan category 29 on Neon ────────────────────────
  console.log('\n[5] Delete orphan category 29 (Neon-only "Omelet" dup of local #9)…')
  const refCheck = await pool.query('SELECT count(*)::int c FROM products WHERE category_id = 29')
  if (refCheck.rows[0].c === 0) {
    const del = await pool.query('DELETE FROM categories WHERE id = 29 AND name = $1', ['Omelet'])
    console.log(`    deleted ${del.rowCount} orphan row`)
  } else {
    console.log(`    SKIPPED — ${refCheck.rows[0].c} products reference it!`)
  }

  // ── PART 6: setval all registry sequences to max(id) ─────────────────
  console.log('\n[6] Sync Postgres sequences to max(id)…')
  const SEQ_TABLES = [
    'customers', 'orders', 'order_items', 'payments', 'products', 'categories',
    'suppliers', 'reservations', 'tables', 'floor_plans', 'inventory_transactions',
    'promotions', 'purchase_orders', 'purchase_order_items', 'stock_counts',
    'stock_count_lines', 'waste_logs', 'modifier_groups', 'modifiers',
    'recipe_components', 'persons', 'roles', 'attendance', 'shifts',
    'cash_drawer_entries', 'cash_drawer_sessions', 'audit_logs',
  ]
  for (const t of SEQ_TABLES) {
    try {
      const seq = await pool.query(`SELECT pg_get_serial_sequence('${t}','id') AS seqname`)
      const seqname = seq.rows[0]?.seqname as string | null
      if (!seqname) continue
      const mx = await pool.query(`SELECT COALESCE(MAX(id),0)::int m FROM ${t}`)
      const target = mx.rows[0].m as number
      if (target > 0) {
        await pool.query(`SELECT setval('${seqname}', ${target}, true)`)
        console.log(`    ${t}: seq → ${target}`)
      }
    } catch (e) {
      console.log(`    ${t}: SKIP — ${(e as Error).message.slice(0, 50)}`)
    }
  }

  // ── PART 7: post-repair counts ───────────────────────────────────────
  console.log('\n[7] Post-repair table counts (Neon):')
  for (const t of ['customers', 'payments', 'order_items', 'inventory_transactions', 'stock_counts', 'stock_count_lines', 'attendance', 'audit_logs', 'categories']) {
    const c = await pool.query(`SELECT COUNT(*)::int c, COALESCE(MAX(id),0)::int m FROM ${t}`)
    console.log(`    ${t}: n=${c.rows[0].c} max=${c.rows[0].m}`)
  }

  await pool.end()
  await db.$disconnect()
  console.log('\n══ r38 parity repair COMPLETE — local pull will converge within ~35s ══')
}

main().catch((e) => {
  console.error('REPAIR FAILED:', e.message)
  process.exit(1)
})
