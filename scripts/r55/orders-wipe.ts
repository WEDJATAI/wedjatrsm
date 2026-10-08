// r55 — OWNER-ORDERED ORDERS WIPE (go-live reset), both planes.
//
// Owner directive (verbatim): "remove all orders, as the live will start
// from now."
//
// WHAT IS REMOVED (and what is deliberately KEPT):
//   REMOVED  · ALL orders (17: 2186-2208 incl. the 5 open mazaj bridge
//             orders 2204-2208) — order_items + payments cascade away
//             with them on BOTH planes (FK CASCADE, verified)
//             · all order-entity audit rows (local 46 / cloud 45)
//             · the mazaj seen-ledger app_settings (cloud 1)
//             · table 55 ("19", occupied by mazaj order 2208) → free
//   KEPT     · inventory_transactions — the 249 'sale' rows survive with
//             order_id SET NULL (the FK action): the stock LEDGER and the
//             materialized product.stock stay consistent with the physical
//             consumption that really happened during the pilot. Wiping
//             the ledger would pretend ingredients were never used.
//             · menu (331 products), users, customers, suppliers, drawer
//               history, attendance — everything that is not an order.
//
// HOW BOTH PLANES + EVERY DEVICE LEARN ABOUT IT:
//   · local SQLite: direct surgery (single transaction)
//   · Neon cloud: direct surgery + SUPERSEDE events emitted into the
//     cloud stream (direction 'out', deviceId 'unbound' — the cloud-origin
//     contract the pull stream serves to every terminal):
//       - AuditLog delete × N, payload { id, __wipe: 'rsm-owner-wipe-v1' }
//         (the r55 append-only wipe gate on the receiving side)
//       - Order delete × N, payload { id } — on every RECEIVING device the
//         FK cascade removes its payments + items (works on pre-r55 agent
//         builds too: Order deletes ride the origin-authority policy,
//         which passes for closed orders and for the mazaj opens with no
//         origin stamp)
//       - RestaurantTable/55 update with the full free row
//   · revisions are stamped ABOVE every cloud watermark per (entity, id)
//
// SAFETY: engine paused for the duration; pre-wipe backups on both planes
// (local VACUUM INTO + full JSON dump of every removed cloud row).
import { Pool } from 'pg'
import { createHash, randomUUID } from 'crypto'
import { Database } from 'bun:sqlite'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'

const env = Object.fromEntries(
  readFileSync('.env.deploy-local', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)

const WIPE_MARKER = 'rsm-owner-wipe-v1'
const log = (msg: string) => console.log(`[r55-wipe] ${msg}`)
let failed = 0
const ok = (cond: boolean, label: string) => {
  console.log(`  ${cond ? '✓' : '✗ FAIL'} — ${label}`)
  if (!cond) failed++
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
mkdirSync('backups', { recursive: true })

async function main() {
  const local = new Database('/home/z/my-project/db/custom.db')
  const pool = new Pool({ connectionString: env.NEON_DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2 })

  // ══════════ PHASE 0 — pre-flight + pause the engine ══════════
  log('PHASE 0 — pre-flight')
  const preOrders = local.query(`SELECT COUNT(*) c FROM orders`).get() as any
  log(`local orders before: ${preOrders.c}`)
  if (preOrders.c === 0) log('local already wiped — continuing for cloud/idempotency')
  local.query(`INSERT INTO hybrid_sync_state (key, value, "updatedAt") VALUES ('sync.paused','1',datetime('now'))
               ON CONFLICT(key) DO UPDATE SET value='1', "updatedAt"=datetime('now')`).run()
  log('engine paused (sync.paused=1); waiting out any in-flight cycle…')
  await sleep(35_000)

  // ══════════ PHASE 1 — backups (both planes) ══════════
  log('PHASE 1 — backups')
  const localBackup = `backups/pre-r55-orders-wipe-${ts}.db`
  local.query(`VACUUM INTO '${localBackup}'`).run()
  log(`local backup: ${localBackup}`)
  const client = await pool.connect()
  const dump: Record<string, unknown[]> = {}
  for (const [name, sql] of Object.entries({
    orders: `SELECT * FROM orders ORDER BY id`,
    order_items: `SELECT * FROM order_items ORDER BY id`,
    payments: `SELECT * FROM payments ORDER BY id`,
    audit_order: `SELECT * FROM audit_logs WHERE entity='order' ORDER BY id`,
    mazaj_seen: `SELECT * FROM app_settings WHERE key LIKE 'mazaj.seen.%'`,
    table55: `SELECT * FROM tables WHERE id=55`,
  })) {
    const r = await client.query(sql)
    dump[name] = r.rows
    log(`cloud dump ${name}: ${r.rowCount} rows`)
  }
  const cloudBackup = `backups/pre-r55-cloud-orders-wipe-${ts}.json`
  writeFileSync(cloudBackup, JSON.stringify(dump, null, 2))
  log(`cloud backup: ${cloudBackup}`)
  const preMaxEvent = await client.query(`SELECT COALESCE(MAX(id),0) m FROM hybrid_events`)
  const preMaxEventId = Number(preMaxEvent.rows[0].m)
  log(`cloud max event id before wipe: ${preMaxEventId}`)

  // capture the exact row ids to wipe (from the AUTHORITATIVE cloud)
  const orderRows = dump.orders as any[]
  const itemRows = dump.order_items as any[]
  const paymentRows = dump.payments as any[]
  const auditRows = dump.audit_order as any[]
  const orderIds = orderRows.map((r) => r.id)

  // tables currently not free that are occupied by a wiped order
  const tableIds: number[] = []
  for (const t of dump.table55 as any[]) tableIds.push(t.id)
  const extraTables = await client.query(
    `SELECT DISTINCT table_id FROM orders WHERE table_id IS NOT NULL AND status IN ('open','deferred')`,
  )
  for (const row of extraTables.rows) if (!tableIds.includes(row.table_id)) tableIds.push(row.table_id)
  log(`tables to free: ${JSON.stringify(tableIds)}`)

  // ══════════ PHASE 2 — LOCAL surgery (single transaction) ══════════
  log('PHASE 2 — local surgery')
  local.transaction(() => {
    const a = local.query(`DELETE FROM audit_logs WHERE entity='order'`).run()
    const s = local.query(`DELETE FROM app_settings WHERE key LIKE 'mazaj.seen.%'`).run()
    const o = local.query(`DELETE FROM orders`).run()
    let t = 0
    for (const tid of tableIds) {
      t += local.query(`UPDATE tables SET status='free' WHERE id=? AND status!='free'`).run(tid).changes
    }
    log(`local: audits=${a.changes} seen-ledgers=${s.changes} orders=${o.changes} (payments+items cascade) tables-freed=${t}`)
  })()

  // ══════════ PHASE 3 — CLOUD surgery + supersede events ══════════
  log('PHASE 3 — cloud surgery (single transaction)')
  await client.query('BEGIN')
  try {
    const a = await client.query(`DELETE FROM audit_logs WHERE entity='order'`)
    const s = await client.query(`DELETE FROM app_settings WHERE key LIKE 'mazaj.seen.%'`)
    const p = await client.query(`DELETE FROM payments`)
    const it = await client.query(`DELETE FROM order_items`)
    const o = await client.query(`DELETE FROM orders`)
    let t = 0
    for (const tid of tableIds) {
      const r = await client.query(`UPDATE tables SET status='free' WHERE id=$1 AND status!='free' RETURNING id`, [tid])
      t += r.rowCount ?? 0
    }
    log(`cloud: audits=${a.rowCount} seen=${s.rowCount} payments=${p.rowCount} items=${it.rowCount} orders=${o.rowCount} tables-freed=${t}`)

    // ── supersede events: revisions above every cloud watermark ──
    const emit = async (entity: string, entityId: string, operation: string, revision: number, payload: object) => {
      const body = JSON.stringify(payload)
      await client.query(
        `INSERT INTO hybrid_events ("eventId","deviceId","entity","entityId","operation","revision","payloadHash","payload","direction","status","attempts","createdAt","updatedAt")
         VALUES ($1,'unbound',$2,$3,$4,$5,$6,$7,'out','pending',0,now(),now())`,
        [randomUUID(), entity, entityId, operation, revision, createHash('sha256').update(body).digest('hex'), body],
      )
    }
    const maxRev = async (entity: string, entityId: string): Promise<number> => {
      const r = await client.query(
        `SELECT COALESCE(MAX(revision),0) rev FROM hybrid_events WHERE entity=$1 AND "entityId"=$2`,
        [entity, entityId],
      )
      return Number(r.rows[0].rev)
    }

    // 1) AuditLog deletes (wipe marker — the r55 append-only gate)
    for (const row of auditRows) {
      const id = String(row.id)
      await emit('AuditLog', id, 'delete', (await maxRev('AuditLog', id)) + 1, { id: row.id, __wipe: WIPE_MARKER })
    }
    log(`supersede: ${auditRows.length} AuditLog deletes (wipe-marked)`)
    // 2) Order deletes — receivers' FK cascade removes payments + items
    for (const row of orderRows) {
      const id = String(row.id)
      await emit('Order', id, 'delete', (await maxRev('Order', id)) + 1, { id: row.id })
    }
    log(`supersede: ${orderRows.length} Order deletes`)
    // 3) table rows → free (full-row supersede update)
    for (const tid of tableIds) {
      const t = await client.query(`SELECT * FROM tables WHERE id=$1`, [tid])
      const row = t.rows[0]
      if (!row) continue
      const payload = {
        id: row.id, floorPlanId: row.floor_plan_id, name: row.name, capacity: row.capacity,
        shape: row.shape, positionX: row.position_x, positionY: row.position_y,
        status: 'free', active: row.active,
      }
      await emit('RestaurantTable', String(tid), 'update', (await maxRev('RestaurantTable', String(tid))) + 1, payload)
    }
    log(`supersede: ${tableIds.length} RestaurantTable free updates`)
    await client.query('COMMIT')
    log('cloud transaction COMMITTED')
  } catch (err) {
    await client.query('ROLLBACK')
    log(`CLOUD SURGERY FAILED — rolled back: ${err instanceof Error ? err.message : err}`)
    throw err
  }

  // ══════════ PHASE 4 — unpause; let the engine pull the wipe ══════════
  log('PHASE 4 — unpausing engine; waiting for the pull cycle to deliver the wipe events')
  local.query(`INSERT INTO hybrid_sync_state (key, value, "updatedAt") VALUES ('sync.paused','0',datetime('now'))
               ON CONFLICT(key) DO UPDATE SET value='0', "updatedAt"=datetime('now')`).run()
  // the engine ticks every 30s; a full pull of ~64 events + applies takes a
  // few cycles — poll until the cursor advances past all events
  let cursor = 0
  for (let i = 0; i < 24; i++) {
    await sleep(15_000)
    const row = local.query(`SELECT value FROM hybrid_sync_state WHERE key='pull.cursor'`).get() as any
    const rem = local.query(`SELECT value FROM hybrid_sync_state WHERE key='pull.remaining'`).get() as any
    cursor = Number(row?.value ?? 0)
    const pending = local.query(`SELECT COUNT(*) c FROM hybrid_events WHERE status='pending' AND direction='out'`).get() as any
    const failedIn = local.query(`SELECT COUNT(*) c FROM hybrid_events WHERE status='failed' AND direction='in'`).get() as any
    log(`  t+${(i + 1) * 15}s cursor=${cursor} remaining=${rem?.value ?? '?'} local-outbox-pending=${pending.c} in-failed=${failedIn.c}`)
    if (Number(rem?.value ?? 1) === 0 && pending.c === 0 && cursor > preMaxEventId) break
  }

  // ══════════ PHASE 5 — verify BOTH planes ══════════
  log('PHASE 5 — verification')
  const vLocal = {
    orders: (local.query(`SELECT COUNT(*) c FROM orders`).get() as any).c,
    items: (local.query(`SELECT COUNT(*) c FROM order_items`).get() as any).c,
    payments: (local.query(`SELECT COUNT(*) c FROM payments`).get() as any).c,
    auditOrder: (local.query(`SELECT COUNT(*) c FROM audit_logs WHERE entity='order'`).get() as any).c,
    invLinked: (local.query(`SELECT COUNT(*) c FROM inventory_transactions WHERE order_id IS NOT NULL`).get() as any).c,
    invTotal: (local.query(`SELECT COUNT(*) c FROM inventory_transactions`).get() as any).c,
    mazajSeen: (local.query(`SELECT COUNT(*) c FROM app_settings WHERE key LIKE 'mazaj.seen.%'`).get() as any).c,
    tablesNotFree: (local.query(`SELECT COUNT(*) c FROM tables WHERE status NOT IN ('free','dirty')`).get() as any).c,
    products: (local.query(`SELECT COUNT(*) c FROM products`).get() as any).c,
    users: (local.query(`SELECT COUNT(*) c FROM users`).get() as any).c,
  }
  const v = async (sql: string) => Number((await client.query(sql)).rows[0].count)
  const vCloud = {
    orders: await v(`SELECT COUNT(*) FROM orders`),
    items: await v(`SELECT COUNT(*) c FROM order_items`),
    payments: await v(`SELECT COUNT(*) c FROM payments`),
    auditOrder: await v(`SELECT COUNT(*) FROM audit_logs WHERE entity='order'`),
    invLinked: await v(`SELECT COUNT(*) FROM inventory_transactions WHERE order_id IS NOT NULL`),
    invTotal: await v(`SELECT COUNT(*) FROM inventory_transactions`),
    mazajSeen: await v(`SELECT COUNT(*) FROM app_settings WHERE key LIKE 'mazaj.seen.%'`),
    tablesNotFree: await v(`SELECT COUNT(*) FROM tables WHERE status NOT IN ('free','dirty')`),
    products: await v(`SELECT COUNT(*) FROM products`),
    users: await v(`SELECT COUNT(*) FROM users`),
  }
  console.log('  local:', JSON.stringify(vLocal))
  console.log('  cloud:', JSON.stringify(vCloud))
  ok(vLocal.orders === 0 && vCloud.orders === 0, 'orders 0/0')
  ok(vLocal.items === 0 && vCloud.items === 0, 'order_items 0/0')
  ok(vLocal.payments === 0 && vCloud.payments === 0, 'payments 0/0')
  ok(vLocal.auditOrder === 0 && vCloud.auditOrder === 0, 'order-entity audits 0/0')
  ok(vLocal.invLinked === 0 && vCloud.invLinked === 0, 'inventory order-links cleared (SET NULL) 0/0')
  ok(vLocal.invTotal === vCloud.invTotal, `inventory ledger preserved ${vLocal.invTotal}/${vCloud.invTotal}`)
  ok(vLocal.mazajSeen === 0 && vCloud.mazajSeen === 0, 'mazaj seen-ledgers 0/0')
  ok(vLocal.tablesNotFree === 0 && vCloud.tablesNotFree === 0, 'no occupied/paid/deferred tables left')
  ok(vLocal.products === vCloud.products, `products parity ${vLocal.products}/${vCloud.products}`)
  ok(vLocal.users === vCloud.users, `users parity ${vLocal.users}/${vCloud.users}`)
  const fIn = (local.query(`SELECT COUNT(*) c FROM hybrid_events WHERE direction='in' AND status='failed'`).get() as any).c
  const fOut = (local.query(`SELECT COUNT(*) c FROM hybrid_events WHERE direction='out' AND status IN ('pending','inflight')`).get() as any).c
  ok(fIn === 0, `no failed in-events (${fIn})`)
  ok(fOut === 0, `outbox fully drained (${fOut})`)
  const appliedWipe = (local.query(
    `SELECT COUNT(*) c FROM hybrid_events WHERE direction='in' AND operation='delete' AND entity IN ('Order','AuditLog')`,
  ).get() as any).c
  log(`wipe delete events applied locally (in-direction): ${appliedWipe}`)

  client.release()
  await pool.end()
  local.close()
  console.log(failed === 0 ? '\n[r55-wipe] ALL CHECKS PASSED — live starts from zero' : `\n[r55-wipe] ${failed} CHECK(S) FAILED`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('[r55-wipe] FATAL:', err)
  process.exit(1)
})
