/**
 * r41 — PARITY REBUILD: make local == Neon for every BUSINESS table.
 *
 * Why wholesale (not row-diff): the local terminal has pushed NOTHING since
 * 2026-10-04 10:59 (lastPushAt, before the r40 cleanup) — every post-cleanup
 * write happened cloud-side (owner on web + desktop agents). Neon is strictly
 * authoritative for business data. The restored local DB (stale pre-cleanup
 * recovery point) differs from Neon in known ways (cursor-gap rows: 7 audit
 * rows, 2 products, modifier deltas, product edits) and possibly unknown ways
 * — a full rebuild closes every gap deterministically.
 *
 * SKIPPED BY DESIGN (not business data):
 *  - app_settings ......... local-first by design (r39 documented decision)
 *  - hybrid_events ........ local outbox+mirror history (pull cursor + failed
 *                           retries depend on it — MUST stay)
 *  - hybrid_conflicts ..... engine metadata
 *  - hybrid_devices ....... device enrollment (engine state)
 *  - hybrid_sync_state .... engine state (cursor, device keys)
 *
 * Mechanics: ONE transaction, PRAGMA foreign_keys=OFF for the swap (order
 * no longer matters), re-enable + PRAGMA foreign_key_check after commit.
 * Postgres → SQLite value conversion: Date→ms, boolean→1/0, int8→number.
 * After this, the remaining 'failed' pull events retry as content-identical
 * no-op upserts and clear themselves.
 */
import { Database } from 'bun:sqlite'
import { Pool } from 'pg'
import { neonPooledUrl } from '../lib/env-local'

const LOCAL = '/home/z/my-project/db/custom.db'

/** business tables, parent-first insert order (delete order is irrelevant with FK off) */
const TABLES = [
  'users', 'roles', 'persons', 'shifts', 'floor_plans', 'tables', 'categories',
  'products', 'modifier_groups', 'modifiers', 'product_modifier_groups',
  'recipe_components', 'customers', 'orders', 'order_items', 'payments',
  'cash_drawer_sessions', 'cash_drawer_entries', 'attendance', 'waste_logs',
  'inventory_transactions', 'stock_counts', 'stock_count_lines', 'suppliers',
  'purchase_orders', 'purchase_order_items', 'promotions', 'reservations',
  'vision_cameras', 'vision_zones', 'vision_events', 'vision_table_states',
  'movement_candidates', 'audit_logs',
] as const

function toSqlite(v: unknown): number | string | bigint | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return v.getTime()
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'object') return JSON.stringify(v) // jsonb columns
  return String(v)
}

async function main() {
  const pool = new Pool({ connectionString: neonPooledUrl(), max: 1 })
  const db = new Database(LOCAL)

  // ── Phase 1: dump Neon (all business tables) ───────────────────────
  const dump = new Map<string, Record<string, unknown>[]>()
  let totalRows = 0
  for (const t of TABLES) {
    const rows = (await pool.query(`select * from ${t}`)).rows as Record<string, unknown>[]
    dump.set(t, rows)
    totalRows += rows.length
    console.log(`  neon ${t.padEnd(26)} ${rows.length}`)
  }
  console.log(`neon total business rows: ${totalRows}`)

  // sanity: the keepers must be there
  const users = dump.get('users')!
  const userIds = users.map((u) => Number(u.id)).sort((a, b) => a - b)
  if (JSON.stringify(userIds) !== JSON.stringify([1, 12, 13, 15, 16])) {
    throw new Error(`neon users changed (${userIds}) — aborting`)
  }
  if (dump.get('orders')!.length < 2) throw new Error('neon orders vanished — aborting')
  if (dump.get('products')!.length < 300) throw new Error('neon products vanished — aborting')

  // ── Phase 2: one atomic swap transaction ───────────────────────────
  db.exec('PRAGMA foreign_keys = OFF') // outside the tx — legal
  const t0 = Date.now()
  db.exec('BEGIN')
  try {
    for (const t of TABLES) {
      db.prepare(`delete from ${t}`).run()
    }
    for (const t of TABLES) {
      const rows = dump.get(t)!
      if (rows.length === 0) continue
      const cols = Object.keys(rows[0])
      const placeholders = cols.map(() => '?').join(', ')
      const stmt = db.prepare(`insert into ${t} (${cols.map((c) => `"${c}"`).join(', ')}) values (${placeholders})`)
      for (const row of rows) {
        stmt.run(...cols.map((c) => toSqlite(row[c])))
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  } finally {
    db.exec('PRAGMA foreign_keys = ON')
  }
  console.log(`swap transaction committed in ${Date.now() - t0}ms`)

  // ── Phase 3: parity verification ───────────────────────────────────
  const failures: string[] = []
  for (const t of TABLES) {
    const localCount = (db.prepare(`select count(*) c from ${t}`).get() as { c: number }).c
    const neonCount = dump.get(t)!.length
    if (localCount !== neonCount) failures.push(`${t}: local ${localCount} ≠ neon ${neonCount}`)
  }
  const fk = db.prepare('PRAGMA foreign_key_check').all()
  if (fk.length) failures.push(`${fk.length} FK violations: ${JSON.stringify(fk.slice(0, 3))}`)
  const integrity = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
  if (integrity.integrity_check !== 'ok') failures.push(`integrity: ${integrity.integrity_check}`)

  // engine state untouched?
  const cursor = db.prepare("select value from hybrid_sync_state where key='pull.cursor'").get() as { value: string }
  const pendingOut = (db.prepare("select count(*) c from hybrid_events where status='pending'").get() as { c: number }).c
  console.log(`engine state intact — cursor ${cursor.value}, pending out ${pendingOut}`)

  const summary = {
    users: db.prepare('select id, name, role from users order by id').all(),
    orders: db.prepare('select id, status, total_amount from orders order by id').all(),
    customers: (db.prepare('select count(*) c from customers').get() as { c: number }).c,
    products: (db.prepare('select count(*) c from products').get() as { c: number }).c,
    audit: db.prepare('select count(*) c, min(id) mn, max(id) mx from audit_logs').get(),
    occupied: db.prepare("select id, status from tables where status <> 'free'").all(),
  }
  console.log('post-rebuild summary:', JSON.stringify(summary, null, 1))

  if (failures.length) {
    console.error('\n✗✗ PARITY FAILURES:', failures.join('; '))
    process.exit(1)
  }
  console.log(`\n✓ PARITY REBUILD PASSED — ${TABLES.length} business tables, ${totalRows} rows, local == Neon`)
  db.close()
  await pool.end()
}

main().catch(async (e) => {
  console.error(e)
  process.exit(1)
})
