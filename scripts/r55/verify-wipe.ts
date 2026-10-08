// r55 — post-wipe verification (both planes), fixed alias queries.
import { Pool } from 'pg'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'fs'
const env = Object.fromEntries(
  readFileSync('.env.deploy-local', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const local = new Database('/home/z/my-project/db/custom.db', { readonly: true })
const pool = new Pool({ connectionString: env.NEON_DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 })
const L = (sql: string) => Number((local.query(sql).get() as any).c)
const C = async (sql: string) => Number(((await pool.query(sql)).rows[0] as any).count)
let failed = 0
const ok = (cond: boolean, label: string) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} — ${label}`); if (!cond) failed++ }

const localCounts = {
  orders: L(`SELECT COUNT(*) c FROM orders`),
  items: L(`SELECT COUNT(*) c FROM order_items`),
  payments: L(`SELECT COUNT(*) c FROM payments`),
  auditOrder: L(`SELECT COUNT(*) c FROM audit_logs WHERE entity='order'`),
  invLinked: L(`SELECT COUNT(*) c FROM inventory_transactions WHERE order_id IS NOT NULL`),
  invTotal: L(`SELECT COUNT(*) c FROM inventory_transactions`),
  mazajSeen: L(`SELECT COUNT(*) c FROM app_settings WHERE key LIKE 'mazaj.seen.%'`),
  tablesNotFree: L(`SELECT COUNT(*) c FROM tables WHERE status NOT IN ('free','dirty')`),
  products: L(`SELECT COUNT(*) c FROM products`),
  users: L(`SELECT COUNT(*) c FROM users`),
  customers: L(`SELECT COUNT(*) c FROM customers`),
  auditTotal: L(`SELECT COUNT(*) c FROM audit_logs`),
  integrity: (local.query(`PRAGMA integrity_check`).get() as any).integrity_check,
  failedIn: L(`SELECT COUNT(*) c FROM hybrid_events WHERE direction='in' AND status='failed'`),
  outboxPending: L(`SELECT COUNT(*) c FROM hybrid_events WHERE direction='out' AND status IN ('pending','inflight')`),
  wipeDeletesApplied: L(`SELECT COUNT(*) c FROM hybrid_events WHERE direction='in' AND operation='delete' AND payload LIKE '%rsm-owner-wipe-v1%'`),
  orderDeletesApplied: L(`SELECT COUNT(*) c FROM hybrid_events WHERE direction='in' AND operation='delete' AND entity='Order' AND payload LIKE '%2186%'`) +
    L(`SELECT COUNT(*) c FROM hybrid_events WHERE direction='in' AND operation='delete' AND entity='Order' AND payload LIKE '%2208%'`),
}
const cloudCounts = {
  orders: await C(`SELECT COUNT(*) FROM orders`),
  items: await C(`SELECT COUNT(*) FROM order_items`),
  payments: await C(`SELECT COUNT(*) FROM payments`),
  auditOrder: await C(`SELECT COUNT(*) FROM audit_logs WHERE entity='order'`),
  invLinked: await C(`SELECT COUNT(*) FROM inventory_transactions WHERE order_id IS NOT NULL`),
  invTotal: await C(`SELECT COUNT(*) FROM inventory_transactions`),
  mazajSeen: await C(`SELECT COUNT(*) FROM app_settings WHERE key LIKE 'mazaj.seen.%'`),
  tablesNotFree: await C(`SELECT COUNT(*) FROM tables WHERE status NOT IN ('free','dirty')`),
  products: await C(`SELECT COUNT(*) FROM products`),
  users: await C(`SELECT COUNT(*) FROM users`),
  customers: await C(`SELECT COUNT(*) FROM customers`),
  auditTotal: await C(`SELECT COUNT(*) FROM audit_logs`),
}
console.log('LOCAL:', JSON.stringify(localCounts, null, 1))
console.log('CLOUD:', JSON.stringify(cloudCounts, null, 1))
ok(localCounts.orders === 0 && cloudCounts.orders === 0, 'orders 0/0')
ok(localCounts.items === 0 && cloudCounts.items === 0, 'order_items 0/0')
ok(localCounts.payments === 0 && cloudCounts.payments === 0, 'payments 0/0')
ok(localCounts.auditOrder === 0 && cloudCounts.auditOrder === 0, 'order-entity audits 0/0')
ok(localCounts.invLinked === 0 && cloudCounts.invLinked === 0, 'inventory order-links cleared 0/0 (SET NULL)')
ok(localCounts.invTotal === cloudCounts.invTotal, `inventory ledger preserved ${localCounts.invTotal}/${cloudCounts.invTotal}`)
ok(localCounts.mazajSeen === 0 && cloudCounts.mazajSeen === 0, 'mazaj seen-ledgers 0/0')
ok(localCounts.tablesNotFree === 0 && cloudCounts.tablesNotFree === 0, 'no occupied tables left')
ok(localCounts.products === cloudCounts.products, `products parity ${localCounts.products}/${cloudCounts.products}`)
ok(localCounts.users === cloudCounts.users, `users parity ${localCounts.users}/${cloudCounts.users}`)
ok(localCounts.customers === cloudCounts.customers, `customers parity ${localCounts.customers}/${cloudCounts.customers}`)
ok(localCounts.auditTotal === cloudCounts.auditTotal, `audit totals parity ${localCounts.auditTotal}/${cloudCounts.auditTotal}`)
ok(localCounts.integrity === 'ok', 'local SQLite integrity ok')
ok(localCounts.failedIn === 0, 'no failed in-events')
ok(localCounts.outboxPending === 0, 'outbox fully drained')
ok(localCounts.wipeDeletesApplied >= 40, `wipe-marked AuditLog deletes applied locally (${localCounts.wipeDeletesApplied})`)
ok(localCounts.orderDeletesApplied === 2, `Order deletes (2186 + 2208 sample) applied locally (${localCounts.orderDeletesApplied})`)
await pool.end(); local.close()
console.log(failed === 0 ? '\nALL CHECKS PASSED — both planes clean, live starts from zero' : `\n${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
