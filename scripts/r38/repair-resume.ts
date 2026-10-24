/**
 * r38 — parity repair RESUME (after the 180s timeout killed the master
 * script mid-audit-backfill). Idempotent continuation of Parts 3-6 +
 * the remaining audit_logs via BATCHED multi-row inserts (500/batch).
 */
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { createHash } from 'node:crypto'
import { neonPooledUrl } from '../lib/env-local'
import { db } from '../../src/lib/db'

const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 4 })

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
const snake = (s: string) => s.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')
function lit(v: unknown): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  if (typeof v === 'object') return `'${JSON.stringify(v).replaceAll("'", "''")}'`
  return `'${String(v).replaceAll("'", "''")}'`
}

async function main() {
  console.log('══ r38 parity repair — RESUME ══')

  // ── PART 3 (redo): restore the 3 order FKs ──────────────────────────
  console.log('\n[3R] Restore order customer FKs (from pre-repair snapshot)…')
  const fk: Array<[number, number]> = [[133, 3], [317, 2], [323, 3]]
  for (const [orderId, custId] of fk) {
    const r = await pool.query('UPDATE orders SET customer_id = $1 WHERE id = $2 AND customer_id IS NULL', [custId, orderId])
    console.log(`    order ${orderId} → customer ${custId} (${r.rowCount})`)
  }

  // ── PART 2R: batched audit_logs backfill ─────────────────────────────
  console.log('\n[2R] Batched audit_logs backfill…')
  const neonAL = await pool.query('SELECT id FROM audit_logs')
  const neonALIds = new Set(neonAL.rows.map((r: { id: number }) => r.id))
  const localAL = await db.auditLog.findMany({ orderBy: { id: 'asc' } })
  const missing = localAL.filter((a) => !neonALIds.has(a.id))
  console.log(`    missing on Neon: ${missing.length}`)
  // audit_logs columns: id, user_id, user_name, person_id, person_name, action, entity, entity_id, details, created_at
  const BATCH = 500
  let done = 0
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH)
    const values = batch
      .map((a) => {
        const r = a as unknown as Record<string, unknown>
        return `(${lit(r.id)}, ${lit(r.userId)}, ${lit(r.userName)}, ${lit(r.personId)}, ${lit(r.personName)}, ${lit(r.action)}, ${lit(r.entity)}, ${lit(r.entityId)}, ${lit(r.details)}, ${lit(r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt)})`
      })
      .join(', ')
    await pool.query(
      `INSERT INTO audit_logs (id, user_id, user_name, person_id, person_name, action, entity, entity_id, details, created_at)
       VALUES ${values} ON CONFLICT (id) DO NOTHING`,
    )
    done += batch.length
  }
  console.log(`    audit_logs backfilled: ${done}`)

  // ── PART 4: emit pull events for Neon-only changes ──────────────────
  console.log('\n[4] Emit pull events (Neon → local)…')
  async function emitEvent(entity: string, entityId: number, operation: string, payload: Record<string, unknown>) {
    const localMax = await db.hybridEvent.aggregate({ where: { entity, entityId }, _max: { revision: true } })
    const revision = (localMax._max.revision ?? 0) + 1
    const payloadJson = JSON.stringify(payload)
    const payloadHash = sha256(payloadJson)
    // skip if an event for this entity/id/rev already exists (idempotency)
    const dup = await pool.query(
      `SELECT 1 FROM hybrid_events WHERE entity=$1 AND "entityId"=$2 AND revision=$3 AND direction='out'`,
      [entity, entityId, revision],
    )
    if ((dup.rowCount ?? 0) > 0) {
      console.log(`    event: ${entity}#${entityId} ${operation} rev${revision} — already emitted, skip`)
      return
    }
    await pool.query(
      `INSERT INTO hybrid_events ("eventId","deviceId","entity","entityId","operation","revision","payloadHash","payload","direction","status","attempts","createdAt","updatedAt")
       VALUES ($1,'unbound',$2,$3,$4,$5,$6,$7,'out','pending',0,now(),now())`,
      [randomUUID(), entity, entityId, operation, revision, payloadHash, payloadJson],
    )
    console.log(`    event: ${entity}#${entityId} ${operation} rev${revision}`)
  }
  const toCamelRow = (row: Record<string, unknown>) => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(row)) out[camel(k)] = v
    return out
  }

  const ehab = await pool.query('SELECT * FROM customers WHERE id = 18')
  const amr = await pool.query('SELECT * FROM customers WHERE id = 19')
  if (ehab.rows[0]) await emitEvent('Customer', 18, 'create', toCamelRow(ehab.rows[0]))
  if (amr.rows[0]) await emitEvent('Customer', 19, 'create', toCamelRow(amr.rows[0]))

  const neonTx = await pool.query('SELECT * FROM inventory_transactions WHERE id >= 467 ORDER BY id')
  for (const t of neonTx.rows) await emitEvent('InventoryTransaction', t.id, 'create', toCamelRow(t))

  for (const pid of [6, 9, 296]) {
    const p = await pool.query('SELECT * FROM products WHERE id = $1', [pid])
    if (p.rows[0]) await emitEvent('Product', pid, 'update', toCamelRow(p.rows[0]))
  }

  // ── PART 5: delete orphan category 29 ────────────────────────────────
  console.log('\n[5] Delete orphan category 29…')
  const refCheck = await pool.query('SELECT count(*)::int c FROM products WHERE category_id = 29')
  if (refCheck.rows[0].c === 0) {
    const del = await pool.query('DELETE FROM categories WHERE id = 29 AND name = $1', ['Omelet'])
    console.log(`    deleted ${del.rowCount} orphan row`)
  } else {
    console.log(`    SKIPPED — ${refCheck.rows[0].c} products reference it!`)
  }

  // ── PART 6: setval all registry sequences ────────────────────────────
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

  // ── PART 7: final counts ─────────────────────────────────────────────
  console.log('\n[7] Final Neon counts:')
  for (const t of ['customers', 'payments', 'order_items', 'inventory_transactions', 'stock_counts', 'stock_count_lines', 'attendance', 'audit_logs', 'categories']) {
    const c = await pool.query(`SELECT COUNT(*)::int c, COALESCE(MAX(id),0)::int m FROM ${t}`)
    console.log(`    ${t}: n=${c.rows[0].c} max=${c.rows[0].m}`)
  }

  await pool.end()
  await db.$disconnect()
  console.log('\n══ RESUME COMPLETE ══')
}

main().catch((e) => {
  console.error('RESUME FAILED:', e.message)
  process.exit(1)
})
