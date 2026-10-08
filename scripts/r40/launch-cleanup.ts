/**
 * r40 — LAUNCH CLEANUP: delete all demo data, keep the menu + created users.
 *
 * User instruction (r40): "delete all demo and be ready for launching. keep
 * the menu, an the create users. delete all orders, and demo users and all
 * other demo info."
 *
 * CLASSIFICATION (from the r40 inspection, both DBs at r39 parity):
 *  KEEP  — menu & config: categories, products, modifiers, modifier groups,
 *          product_modifier_groups, recipe_components, floor plans, tables
 *          (rows), roles, promotions, shifts, app_settings, vision cameras +
 *          zones, engine state (hybrid_*). Product.stock untouched (real
 *          physical inventory — the menu is kept exactly as configured).
 *  KEEP  — users: #1 Dr Ihab (owner/super-admin), #12 Meena, #13 Amira
 *          (owner-created via the Users page — "the create users"), their
 *          persons (#7 اميره, #8 Ramadan).
 *  DELETE — ALL orders + order_items + payments, ALL customers, ALL
 *          attendance, ALL waste logs, ALL audit logs (demo-era trail),
 *          ALL inventory ledger, ALL stock counts, ALL purchase orders,
 *          the demo supplier, ALL reservations, ALL cash drawer sessions +
 *          entries, ALL vision events, ALL movement candidates, demo users
 *          (#2,#3,#4,#9,#10,#11 — explicit list ONLY, never anything else),
 *          their persons.
 *  RESET — every table status → 'free'; vision table states → 'unknown'.
 *
 * SYNC STRATEGY (why direct deletes, not outbox events):
 *  The append-only policy (Payment/CashDrawerEntry/InventoryTransaction/
 *  WasteLog/AuditLog/Attendance) REJECTS remote deletes by design — delete
 *  events would be acked-but-skipped and the cloud would keep the demo rows.
 *  So this follows the r38/r39 surgical-repair class instead: delete the
 *  same rows DIRECTLY on local SQLite AND Neon in one transaction each.
 *  Fresh devices are safe: bootstrap is a full SNAPSHOT of current state
 *  (agent-desktop skips every event older than its bootstrapAt), the only
 *  enrolled device is the local terminal itself (cursor 11044 = current),
 *  and the desktop agents re-bootstrap periodically. Turso is a wholesale
 *  replica of local (full refresh after this script). hybrid_events /
 *  sequences are left untouched (append-only history keeps replay safety:
 *  old ids 1..2013 are retired forever; new ids continue above them).
 *
 * SAFETY:
 *  - Full local DB copy + Neon JSON dump of every touched table BEFORE any
 *    delete (backups/r40/).
 *  - Users are deleted ONLY from the explicit demo list — an unknown user
 *    (e.g. one created after this inspection) is never touched.
 *  - One $transaction (local) / one BEGIN..COMMIT (Neon) — all-or-nothing.
 *  - Post-flight parity assertions; non-zero exit on any mismatch.
 */
import { Pool } from 'pg'
import { mkdirSync, writeFileSync } from 'node:fs'
import { db } from '../../src/lib/db'
import { neonPooledUrl } from '../lib/env-local'

const ROOT = '/home/z/my-project'
const BACKUP_DIR = `${ROOT}/backups/r40`
const STAMP = new Date().toISOString().replace(/[:T-]/g, '').slice(0, 15)

/** The ONLY users this script may delete. Anything else is preserved. */
const DEMO_USER_IDS = [2, 3, 4, 9, 10, 11] as const
/** The users that must survive (asserted present both sides). */
const KEEP_USER_IDS = [1, 12, 13] as const

const pool = new Pool({ connectionString: neonPooledUrl(), max: 1 })
const q = async <T>(sql: string, params?: unknown[]): Promise<T[]> =>
  (await pool.query(sql, params)).rows as T[]

async function main() {
  mkdirSync(BACKUP_DIR, { recursive: true })

  // ── Phase 0: pre-flight counts + safety assertions ─────────────────
  console.log('── Phase 0: pre-flight ──')
  const localUsers = await db.user.findMany({ select: { id: true, name: true, email: true, isSuperAdmin: true } })
  const localIds = localUsers.map((u) => u.id).sort((a, b) => a - b)
  const unexpected = localIds.filter((id) => !DEMO_USER_IDS.includes(id as never) && !KEEP_USER_IDS.includes(id as never))
  if (unexpected.length) throw new Error(`UNKNOWN users present (refusing to run — extend DEMO_USER_IDS after review): ${unexpected}`)
  for (const id of KEEP_USER_IDS) {
    if (!localIds.includes(id)) throw new Error(`KEEP user #${id} missing locally — aborting`)
  }
  const keepNames = localUsers.filter((u) => KEEP_USER_IDS.includes(u.id as never)).map((u) => `#${u.id} ${u.name}`).join(', ')
  console.log(`  local users: ${localIds.join(',')} — keeping ${keepNames}`)

  const neonUsers = await q<{ id: number; name: string }>('select id, name from users order by id')
  const neonIds = neonUsers.map((u) => u.id)
  const neonUnexpected = neonIds.filter((id) => !DEMO_USER_IDS.includes(id as never) && !KEEP_USER_IDS.includes(id as never))
  if (neonUnexpected.length) throw new Error(`UNKNOWN users on Neon (refusing): ${neonUnexpected}`)
  for (const id of KEEP_USER_IDS) if (!neonIds.includes(id)) throw new Error(`KEEP user #${id} missing on Neon — aborting`)
  console.log(`  neon users: ${neonIds.join(',')} — same classification ✓`)

  const pre = {
    local: {
      orders: await db.order.count(), orderItems: await db.orderItem.count(), payments: await db.payment.count(),
      customers: await db.customer.count(), attendance: await db.attendance.count(), wasteLogs: await db.wasteLog.count(),
      auditLogs: await db.auditLog.count(), inventory: await db.inventoryTransaction.count(),
      stockCounts: await db.stockCount.count(), stockLines: await db.stockCountLine.count(),
      purchaseOrders: await db.purchaseOrder.count(), poItems: await db.purchaseOrderItem.count(),
      suppliers: await db.supplier.count(), reservations: await db.reservation.count(),
      drawerSessions: await db.cashDrawerSession.count(), drawerEntries: await db.cashDrawerEntry.count(),
      visionEvents: await db.visionEvent.count(), movements: await db.movementCandidate.count(),
      users: await db.user.count(), persons: await db.person.count(),
      products: await db.product.count(), categories: await db.category.count(),
      tables: await db.restaurantTable.count(),
    },
  }
  console.log('  pre-local:', JSON.stringify(pre.local))

  // ── Phase 1: backups (local snapshot + Neon JSON dump) ─────────────
  console.log('── Phase 1: backups ──')
  // r41 fix: copyFileSync on a live WAL-mode db can capture a pre-checkpoint
  // state (the exact bug that shipped a stale recovery point at r40) —
  // VACUUM INTO produces a consistent snapshot instead.
  const localBackupPath = `${BACKUP_DIR}/custom-pre-delete-${STAMP}.db`.replace(/'/g, "''")
  await db.$executeRawUnsafe(`VACUUM INTO '${localBackupPath}'`)
  console.log(`  local db snapshot → backups/r40/custom-pre-delete-${STAMP}.db`)

  const NEON_DUMP_TABLES: Array<[string, string]> = [
    ['orders', 'select * from orders'], ['order_items', 'select * from order_items'],
    ['payments', 'select * from payments'], ['customers', 'select * from customers'],
    ['attendance', 'select * from attendance'], ['waste_logs', 'select * from waste_logs'],
    ['audit_logs', 'select * from audit_logs'], ['inventory_transactions', 'select * from inventory_transactions'],
    ['stock_counts', 'select * from stock_counts'], ['stock_count_lines', 'select * from stock_count_lines'],
    ['purchase_orders', 'select * from purchase_orders'], ['purchase_order_items', 'select * from purchase_order_items'],
    ['suppliers', 'select * from suppliers'], ['reservations', 'select * from reservations'],
    ['cash_drawer_sessions', 'select * from cash_drawer_sessions'], ['cash_drawer_entries', 'select * from cash_drawer_entries'],
    ['vision_events', 'select * from vision_events'], ['movement_candidates', 'select * from movement_candidates'],
    ['persons', 'select * from persons'], ['users', 'select * from users'],
    ['tables', 'select * from tables'], ['vision_table_states', 'select * from vision_table_states'],
  ]
  const dump: Record<string, unknown[]> = {}
  for (const [name, sql] of NEON_DUMP_TABLES) {
    dump[name] = (await q(sql)) as unknown[]
    // normalize dates to ISO strings for a stable JSON artifact
    for (const row of dump[name] as Record<string, unknown>[])
      for (const k of Object.keys(row)) if (row[k] instanceof Date) row[k] = (row[k] as Date).toISOString()
  }
  writeFileSync(`${BACKUP_DIR}/neon-pre-delete-${STAMP}.json`, JSON.stringify({ dumpedAt: new Date().toISOString(), tables: dump }, null, 1))
  const dumpedRows = Object.values(dump).reduce((n, t) => n + t.length, 0)
  console.log(`  neon dump → backups/r40/neon-pre-delete-${STAMP}.json (${dumpedRows} rows across ${NEON_DUMP_TABLES.length} tables)`)

  // ── Phase 2: LOCAL deletion (single atomic transaction) ────────────
  console.log('── Phase 2: local cleanup (one transaction) ──')
  const t0 = Date.now()
  await db.$transaction(async (tx) => {
    // children first — FK-safe order (Prisma enforces FKs on SQLite)
    await tx.cashDrawerEntry.deleteMany({})
    await tx.cashDrawerSession.deleteMany({})
    await tx.payment.deleteMany({})
    await tx.orderItem.deleteMany({})
    await tx.inventoryTransaction.deleteMany({})
    await tx.reservation.deleteMany({})
    await tx.order.deleteMany({})
    await tx.customer.deleteMany({})
    await tx.attendance.deleteMany({})
    await tx.wasteLog.deleteMany({})
    await tx.stockCountLine.deleteMany({})
    await tx.stockCount.deleteMany({})
    await tx.purchaseOrderItem.deleteMany({})
    await tx.purchaseOrder.deleteMany({})
    await tx.supplier.deleteMany({})
    await tx.auditLog.deleteMany({})
    await tx.visionEvent.deleteMany({})
    await tx.movementCandidate.deleteMany({})
    await tx.person.deleteMany({ where: { userId: { in: [...DEMO_USER_IDS] } } })
    await tx.user.deleteMany({ where: { id: { in: [...DEMO_USER_IDS] } } })
    // launch-state resets (floor clean for day one)
    await tx.restaurantTable.updateMany({ data: { status: 'free' } })
    await tx.visionTableState.updateMany({
      data: { state: 'unknown', peopleCount: 0, confidence: 0, stateSince: new Date(), lastEventAt: null, pendingEmptySince: null, manualHoldUntil: null },
    })
  })
  console.log(`  local transaction committed in ${Date.now() - t0}ms`)

  // ── Phase 3: NEON deletion (single atomic transaction) ─────────────
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
    await client.query('DELETE FROM persons WHERE user_id = ANY($1)', [[...DEMO_USER_IDS]])
    await client.query('DELETE FROM users WHERE id = ANY($1)', [[...DEMO_USER_IDS]])
    await client.query("UPDATE tables SET status = 'free'")
    await client.query(`UPDATE vision_table_states SET state = 'unknown', people_count = 0, confidence = 0,
      state_since = now(), last_event_at = NULL, pending_empty_since = NULL, manual_hold_until = NULL`)
    await client.query('COMMIT')
    console.log(`  neon transaction committed in ${Date.now() - t1}ms`)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  // ── Phase 4: post-flight parity verification ───────────────────────
  console.log('── Phase 4: post-flight verification ──')
  const expectZero = ['orders', 'order_items', 'payments', 'customers', 'attendance', 'waste_logs', 'audit_logs',
    'inventory_transactions', 'stock_counts', 'stock_count_lines', 'purchase_orders', 'purchase_order_items',
    'suppliers', 'reservations', 'cash_drawer_sessions', 'cash_drawer_entries', 'vision_events', 'movement_candidates'] as const
  let failures = 0
  for (const t of expectZero) {
    const lc = await q<{ c: number }>(`select count(*)::int c from ${t}`)
    if (lc[0].c !== 0) { console.error(`  ✗ neon ${t}: ${lc[0].c} (expected 0)`); failures++ }
  }
  const post = {
    local: {
      orders: await db.order.count(), orderItems: await db.orderItem.count(), payments: await db.payment.count(),
      customers: await db.customer.count(), attendance: await db.attendance.count(), wasteLogs: await db.wasteLog.count(),
      auditLogs: await db.auditLog.count(), inventory: await db.inventoryTransaction.count(),
      stockCounts: await db.stockCount.count(), stockLines: await db.stockCountLine.count(),
      purchaseOrders: await db.purchaseOrder.count(), poItems: await db.purchaseOrderItem.count(),
      suppliers: await db.supplier.count(), reservations: await db.reservation.count(),
      drawerSessions: await db.cashDrawerSession.count(), drawerEntries: await db.cashDrawerEntry.count(),
      visionEvents: await db.visionEvent.count(), movements: await db.movementCandidate.count(),
      users: await db.user.count(), persons: await db.person.count(),
      products: await db.product.count(), categories: await db.category.count(), tables: await db.restaurantTable.count(),
    },
    localUsers: (await db.user.findMany({ select: { id: true, name: true } })).map((u) => `#${u.id} ${u.name}`).join(' | '),
    localPersons: (await db.person.findMany({ select: { id: true, name: true } })).map((p) => `#${p.id} ${p.name}`).join(' | '),
    nonFreeTables: await db.restaurantTable.count({ where: { status: { not: 'free' } } }),
    unknownVisionStates: await db.visionTableState.count({ where: { state: { not: 'unknown' } } }),
  }
  console.log('  post-local:', JSON.stringify(post.local))
  console.log(`  users left: ${post.localUsers}`)
  console.log(`  persons left: ${post.localPersons}`)
  console.log(`  tables not-free: ${post.nonFreeTables} (expect 0) · vision states not-unknown: ${post.unknownVisionStates} (expect 0)`)

  for (const [k, v] of Object.entries(post.local)) {
    if (['users', 'persons', 'products', 'categories', 'tables'].includes(k)) continue
    if (v !== 0) { console.error(`  ✗ local ${k}: ${v} (expected 0)`); failures++ }
  }
  if (post.local.users !== 3) { console.error(`  ✗ local users: ${post.local.users} (expected 3)`); failures++ }
  if (post.local.persons !== 2) { console.error(`  ✗ local persons: ${post.local.persons} (expected 2)`); failures++ }
  if (post.local.products !== pre.local.products) { console.error(`  ✗ products changed: ${pre.local.products} → ${post.local.products}`); failures++ }
  if (post.local.categories !== pre.local.categories) { console.error(`  ✗ categories changed: ${pre.local.categories} → ${post.local.categories}`); failures++ }
  if (post.nonFreeTables !== 0) failures++
  if (post.unknownVisionStates !== 0) failures++

  const neonPost = {
    users: (await q<{ c: number }>('select count(*)::int c from users'))[0].c,
    persons: (await q<{ c: number }>('select count(*)::int c from persons'))[0].c,
    products: (await q<{ c: number }>('select count(*)::int c from products'))[0].c,
    nonFreeTables: (await q<{ c: number }>("select count(*)::int c from tables where status <> 'free'"))[0].c,
    neonUsers: (await q<{ id: number; name: string }>('select id, name from users order by id')).map((u) => `#${u.id} ${u.name}`).join(' | '),
  }
  console.log(`  neon left: users=${neonPost.users} persons=${neonPost.persons} products=${neonPost.products} non-free-tables=${neonPost.nonFreeTables}`)
  console.log(`  neon users left: ${neonPost.neonUsers}`)
  if (neonPost.users !== 3 || neonPost.persons !== 2 || neonPost.products !== 303 || neonPost.nonFreeTables !== 0) failures++

  if (failures) {
    console.error(`\n✗✗ ${failures} POST-FLIGHT CHECKS FAILED — inspect backups/r40/ and do NOT deploy`)
    process.exit(1)
  }
  console.log('\n✓ ALL CHECKS PASSED — demo data deleted on local + Neon; menu & created users preserved; floor reset to free.')
  await db.$disconnect()
  await pool.end()
}

main().catch(async (e) => {
  console.error(e)
  await pool.end().catch(() => {})
  process.exit(1)
})
