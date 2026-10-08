// r50: pre-verification state snapshot — capture the baseline before the
// two-way roundtrip + mazaj E2E so zero-residue can be PROVEN afterward.
// Read-only on both planes (local SQLite + Neon cloud).
import { Pool } from 'pg'
import { createClient } from '@libsql/client'
import { neonPooledUrl } from '../lib/env-local'

const ldb = createClient({ url: 'file:db/custom.db' })
const neon = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })

const localOne = async (sql: string): Promise<Record<string, unknown>> => {
  const r = await ldb.execute(sql)
  return (r.rows[0] ?? {}) as Record<string, unknown>
}

async function main() {
  console.log('r50 pre-state —', new Date().toISOString())

  // ── local engine state ──
  const state = await ldb.execute('SELECT key, value FROM hybrid_sync_state')
  const stateMap = new Map(state.rows.map((r) => [String(r.key), String(r.value)]))
  console.log('LOCAL ENGINE STATE:')
  for (const k of ['pull.cursor', 'pull.remaining', 'lastPushAt', 'lastPullAt', 'cloud.reachable', 'sync.paused']) {
    if (stateMap.has(k)) console.log(`  ${k} = ${stateMap.get(k)}`)
  }

  // ── local counts ──
  const l = {
    orders: await localOne('SELECT COUNT(*) c FROM orders'),
    items: await localOne('SELECT COUNT(*) c FROM order_items'),
    products: await localOne('SELECT COUNT(*) c FROM products'),
    users: await localOne('SELECT COUNT(*) c FROM users'),
    audit: await localOne('SELECT COUNT(*) c, COALESCE(MAX(id),0) mx FROM audit_logs'),
    suppliers: await localOne('SELECT COUNT(*) c, COALESCE(MAX(id),0) mx FROM suppliers'),
    customers: await localOne('SELECT COUNT(*) c, COALESCE(MAX(id),0) mx FROM customers'),
    outboxPending: await localOne("SELECT COUNT(*) c FROM hybrid_events WHERE direction='out' AND status='pending'"),
    outboxDead: await localOne("SELECT COUNT(*) c FROM hybrid_events WHERE status='dead'"),
    maxEventIn: await localOne('SELECT COALESCE(MAX(id),0) mx FROM hybrid_events'),
  }
  console.log('LOCAL COUNTS:', JSON.stringify({
    orders: l.orders.c, items: l.items.c, products: l.products.c, users: l.users.c,
    audit: `${l.audit.c} (max ${l.audit.mx})`, suppliers: `${l.suppliers.c} (max ${l.suppliers.mx})`,
    customers: `${l.customers.c} (max ${l.customers.mx})`,
    outboxPending: l.outboxPending.c, outboxDead: l.outboxDead.c, maxLocalEventId: l.maxEventIn.mx,
  }))

  // ── neon counts ──
  const q = async (sql: string) => (await neon.query(sql)).rows[0] as Record<string, unknown>
  const n = {
    orders: await q('SELECT COUNT(*)::int c FROM orders'),
    products: await q('SELECT COUNT(*)::int c FROM products'),
    users: await q('SELECT COUNT(*)::int c FROM users'),
    audit: await q('SELECT COUNT(*)::int c, COALESCE(MAX(id),0) mx FROM audit_logs'),
    suppliers: await q('SELECT COUNT(*)::int c, COALESCE(MAX(id),0) mx FROM suppliers'),
    customers: await q('SELECT COUNT(*)::int c, COALESCE(MAX(id),0) mx FROM customers'),
    events: await q('SELECT COUNT(*)::int c, COALESCE(MAX(id),0) mx FROM hybrid_events'),
    eventsLastHour: await q('SELECT COUNT(*)::int c FROM hybrid_events WHERE "createdAt" > now() - interval \'1 hour\''),
    devicesActive: await q("SELECT COUNT(*)::int c FROM hybrid_devices WHERE status='active'"),
  }
  console.log('NEON COUNTS:', JSON.stringify({
    orders: n.orders.c, products: n.products.c, users: n.users.c,
    audit: `${n.audit.c} (max ${n.audit.mx})`, suppliers: `${n.suppliers.c} (max ${n.suppliers.mx})`,
    customers: `${n.customers.c} (max ${n.customers.mx})`,
    eventsTotal: `${n.events.c} (max id ${n.events.mx})`, eventsLastHour: n.eventsLastHour.c,
    devicesActive: n.devicesActive.c,
  }))

  // ── parity verdict ──
  const cursor = Number(stateMap.get('pull.cursor') ?? 0)
  const neonMax = Number(n.events.mx)
  console.log(`PARITY: local pull.cursor=${cursor} vs Neon max event id=${neonMax} → ${cursor >= neonMax ? 'LOCAL IS CURRENT (cursor ≥ stream head)' : `BEHIND by ${neonMax - cursor} events (engine will pull)`}`)

  // ── mazaj context on RSM (Neon): products + recent integration audit + recent mazaj orders ──
  const mazajProducts = (await neon.query("SELECT id, sku, name, price, active FROM products WHERE sku LIKE 'MAZAJ-%' ORDER BY sku")).rows
  console.log(`MAZAJ CATALOG MIRROR (${mazajProducts.length} SKUs):`)
  for (const p of mazajProducts) console.log(`  #${p.id} ${p.sku} — ${p.name} EGP ${p.price} active=${p.active}`)
  const recentMazajAudit = (await neon.query(
    "SELECT id, action, details, created_at FROM audit_logs WHERE action LIKE 'integration.mazaj%' ORDER BY id DESC LIMIT 6"
  )).rows
  console.log('RECENT mazaj INTEGRATION AUDIT (Inngest job evidence):')
  for (const a of recentMazajAudit) console.log(`  #${a.id} ${a.action} @ ${a.created_at} — ${String(a.details).slice(0, 110)}`)
  const mazajOrders = (await neon.query(
    "SELECT id, external_ref, status, total_amount, created_at FROM orders WHERE external_ref LIKE 'mazaj:%' ORDER BY id DESC LIMIT 5"
  )).rows
  console.log('RECENT mazaj-ref ORDERS ON RSM:')
  for (const o of mazajOrders) console.log(`  #${o.id} ${o.external_ref} ${o.status} EGP ${o.total_amount} @ ${o.created_at}`)

  // ── webhook key + tables (for the E2E) ──
  const key = await q("SELECT value FROM app_settings WHERE key='deliveryWebhookKey'")
  console.log(`WEBHOOK KEY configured: ${key ? 'yes (' + String(key.value).slice(0, 6) + '…' + String(key.value).slice(-4) + ')' : 'NO'}`)
  const freeTables = (await neon.query(
    "SELECT t.id, t.name, t.status, f.name AS floor FROM tables t LEFT JOIN floor_plans f ON t.floor_plan_id=f.id WHERE t.status='free' AND t.active=true ORDER BY t.id LIMIT 5"
  )).rows
  console.log('FREE TABLES (candidates for the E2E):', JSON.stringify(freeTables))

  await neon.end()
  ldb.close()
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1) })
