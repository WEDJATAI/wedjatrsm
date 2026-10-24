/**
 * r40 — launch cleanup, Neon continuation (Phase 3 + 4 only).
 *
 * The first run committed the LOCAL transaction but rolled the NEON one
 * back (vision_table_states uses Prisma's UNMAPPED camelCase column
 * "peopleCount" — the first script assumed people_count). Local is already
 * clean; Neon still holds the demo data. This script redoes the Neon side
 * with the verified column list (information_schema confirmed: table_id,
 * state, "peopleCount", confidence, state_since, last_event_at,
 * pending_empty_since, manual_hold_until, updated_at) and then runs the
 * full post-flight parity verification for BOTH databases.
 */
import { Pool } from 'pg'
import { db } from '../../src/lib/db'
import { neonPooledUrl } from '../lib/env-local'

const DEMO_USER_IDS = [2, 3, 4, 9, 10, 11]
const KEEP_USER_IDS = [1, 12, 13]

const pool = new Pool({ connectionString: neonPooledUrl(), max: 1 })
const q = async <T>(sql: string, params?: unknown[]): Promise<T[]> => (await pool.query(sql, params)).rows as T[]

async function main() {
  // safety: neon user set must still be the full pre-delete set
  const neonUsers = await q<{ id: number; name: string }>('select id, name from users order by id')
  const neonIds = neonUsers.map((u) => u.id)
  const unexpected = neonIds.filter((id) => !DEMO_USER_IDS.includes(id) && !KEEP_USER_IDS.includes(id))
  if (unexpected.length) throw new Error(`UNKNOWN users on Neon (refusing): ${unexpected}`)
  if (neonUsers.length !== 9) throw new Error(`expected 9 neon users pre-delete, found ${neonUsers.length}`)
  console.log(`  neon users pre-delete: ${neonIds.join(',')} ✓ (demo: ${DEMO_USER_IDS}, keep: ${KEEP_USER_IDS})`)

  console.log('── Phase 3: neon cleanup (one transaction) ──')
  const client = await pool.connect()
  const t1 = Date.now()
  try {
    await client.query('BEGIN')
    await client.query('DELETE FROM cash_drawer_entries')
    await client.query('DELETE FROM cash_drawer_sessions')
    await client.query('DELETE FROM payments')
    await client.query('DELETE FROM order_items')
    await client.query('DELETE FROM inventory_transactions')
    await client.query('DELETE FROM reservations')
    await client.query('DELETE FROM orders')
    await client.query('DELETE FROM customers')
    await client.query('DELETE FROM attendance')
    await client.query('DELETE FROM waste_logs')
    await client.query('DELETE FROM stock_count_lines')
    await client.query('DELETE FROM stock_counts')
    await client.query('DELETE FROM purchase_order_items')
    await client.query('DELETE FROM purchase_orders')
    await client.query('DELETE FROM suppliers')
    await client.query('DELETE FROM audit_logs')
    await client.query('DELETE FROM vision_events')
    await client.query('DELETE FROM movement_candidates')
    await client.query('DELETE FROM persons WHERE user_id = ANY($1)', [DEMO_USER_IDS])
    await client.query('DELETE FROM users WHERE id = ANY($1)', [DEMO_USER_IDS])
    await client.query("UPDATE tables SET status = 'free'")
    await client.query(`UPDATE vision_table_states SET state = 'unknown', "peopleCount" = 0, confidence = 0,
      state_since = now(), last_event_at = NULL, pending_empty_since = NULL, manual_hold_until = NULL, updated_at = now()`)
    await client.query('COMMIT')
    console.log(`  neon transaction committed in ${Date.now() - t1}ms`)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  console.log('── Phase 4: post-flight verification (both sides) ──')
  const expectZeroNeon = ['orders', 'order_items', 'payments', 'customers', 'attendance', 'waste_logs', 'audit_logs',
    'inventory_transactions', 'stock_counts', 'stock_count_lines', 'purchase_orders', 'purchase_order_items',
    'suppliers', 'reservations', 'cash_drawer_sessions', 'cash_drawer_entries', 'vision_events', 'movement_candidates']
  let failures = 0
  for (const t of expectZeroNeon) {
    const r = (await q<{ c: number }>(`select count(*)::int c from ${t}`))[0].c
    if (r !== 0) { console.error(`  ✗ neon ${t}: ${r}`); failures++ }
  }
  const neonPost = {
    users: (await q<{ c: number }>('select count(*)::int c from users'))[0].c,
    persons: (await q<{ c: number }>('select count(*)::int c from persons'))[0].c,
    products: (await q<{ c: number }>('select count(*)::int c from products'))[0].c,
    categories: (await q<{ c: number }>('select count(*)::int c from categories'))[0].c,
    modifiers: (await q<{ c: number }>('select count(*)::int c from modifiers'))[0].c,
    recipeComponents: (await q<{ c: number }>('select count(*)::int c from recipe_components'))[0].c,
    nonFreeTables: (await q<{ c: number }>("select count(*)::int c from tables where status <> 'free'"))[0].c,
    nonUnknownVision: (await q<{ c: number }>(`select count(*)::int c from vision_table_states where state <> 'unknown' or "peopleCount" <> 0`))[0].c,
    hybridEvents: (await q<{ c: number }>('select count(*)::int c from hybrid_events'))[0].c,
    usersLeft: (await q<{ id: number; name: string }>('select id, name from users order by id')).map((u) => `#${u.id} ${u.name}`).join(' | '),
    personsLeft: (await q<{ id: number; name: string }>('select id, name from persons order by id')).map((p) => `#${p.id} ${p.name}`).join(' | '),
  }
  console.log(`  neon: users=${neonPost.users} persons=${neonPost.persons} products=${neonPost.products} categories=${neonPost.categories} modifiers=${neonPost.modifiers} recipes=${neonPost.recipeComponents} hybrid_events=${neonPost.hybridEvents} (untouched)`)
  console.log(`  neon users left: ${neonPost.usersLeft}`)
  console.log(`  neon persons left: ${neonPost.personsLeft}`)
  console.log(`  neon non-free tables=${neonPost.nonFreeTables} non-unknown vision=${neonPost.nonUnknownVision} (both expect 0)`)

  const localPost = {
    users: await db.user.count(), persons: await db.person.count(), products: await db.product.count(),
    categories: await db.category.count(), orders: await db.order.count(), payments: await db.payment.count(),
    customers: await db.customer.count(), auditLogs: await db.auditLog.count(), attendance: await db.attendance.count(),
    nonFreeTables: await db.restaurantTable.count({ where: { status: { not: 'free' } } }),
    hybridEvents: await db.hybridEvent.count(),
    usersLeft: (await db.user.findMany({ select: { id: true, name: true } })).map((u) => `#${u.id} ${u.name}`).join(' | '),
    personsLeft: (await db.person.findMany({ select: { id: true, name: true } })).map((p) => `#${p.id} ${p.name}`).join(' | '),
  }
  console.log(`  local: users=${localPost.users} persons=${localPost.persons} products=${localPost.products} orders=${localPost.orders} payments=${localPost.payments} customers=${localPost.customers} audit=${localPost.auditLogs} attendance=${localPost.attendance} hybrid_events=${localPost.hybridEvents} (untouched)`)
  console.log(`  local users left: ${localPost.usersLeft}`)
  console.log(`  local persons left: ${localPost.personsLeft}`)

  if (localPost.users !== 3 || localPost.persons !== 2 || localPost.products !== 303) failures++
  if (localPost.orders !== 0 || localPost.payments !== 0 || localPost.customers !== 0 || localPost.auditLogs !== 0 || localPost.attendance !== 0) failures++
  if (localPost.nonFreeTables !== 0) failures++
  if (neonPost.users !== 3 || neonPost.persons !== 2 || neonPost.products !== 303 || neonPost.categories !== 28) failures++
  if (neonPost.nonFreeTables !== 0 || neonPost.nonUnknownVision !== 0) failures++
  if (localPost.usersLeft !== neonPost.usersLeft || localPost.personsLeft !== neonPost.personsLeft) failures++

  if (failures) { console.error(`\n✗✗ ${failures} CHECKS FAILED`); process.exit(1) }
  console.log('\n✓ LAUNCH CLEANUP COMPLETE — local + Neon at clean launch state; menu/users/persons preserved identically; hybrid event logs untouched on both sides.')
  await db.$disconnect()
  await pool.end()
}

main().catch(async (e) => { console.error(e); await pool.end().catch(() => {}); process.exit(1) })
