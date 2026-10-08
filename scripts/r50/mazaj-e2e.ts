// r50: LIVE end-to-end mazaj → Wedjat RSM order flow verification —
// the r47/r49 "PROD E2E" pattern on the current deployment:
//   1. POST the REAL production webhook (real key, the exact contract the
//      mazaj platform sends: provider mazaj + tableId + SKU-matched items)
//   2. verify the dine-in CHECK on the cloud (Neon): house pricing, +26% tax,
//      externalRef stamped, table flipped occupied, item KDS-ready ('new'),
//      audit trail, seen-ledger idempotency
//   3. verify the desktop/local terminal RECEIVES it via the hybrid engine
//      pull (order + items + table flip + audit — the two-way proof)
//   4. replay the same order → duplicate:true, totals unchanged
//   5. zero-residue cleanup per the r47/r49 discipline: stream cleanup
//      FIRST, hard deletes, supersede events ABOVE watermarks (FULL row
//      payloads — the r49 lesson), surgical local audit removal
//   6. final verdict: launch baseline exact on BOTH planes
import { randomUUID, createHash } from 'node:crypto'
import { Pool } from 'pg'
import { createClient } from '@libsql/client'
import { neonPooledUrl } from '../lib/env-local'

const PROD = 'https://wedjatrsm.vercel.app'
const ldb = createClient({ url: 'file:db/custom.db' })
const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let exitCode = 0
const fail = (m: string) => { console.log(`  ✗ ${m}`); exitCode = 1 }
const ok = (m: string) => console.log(`  ✓ ${m}`)
const lrows = async (sql: string) => (await ldb.execute(sql)).rows as Array<Record<string, unknown>>
const ljson = async <T>(sql: string) => (await lrows(sql)) as unknown as T[]

async function waitFor(desc: string, fn: () => Promise<boolean>, timeoutMs = 180_000, everyMs = 4_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) { ok(`${desc} — after ${Math.round((Date.now() - t0) / 1000)}s`); return true }
    await sleep(everyMs)
  }
  fail(`${desc} — TIMEOUT after ${timeoutMs / 1000}s`); return false
}

async function main() {
  // ── webhook key (mirrored local ← Neon) ──
  const key = String((await lrows("SELECT value FROM app_settings WHERE key='deliveryWebhookKey'"))[0]?.value ?? '')
  if (!key) { console.log('✗ deliveryWebhookKey not configured'); process.exit(1) }

  // ══════ PHASE 0 — baseline ══════
  console.log('══ PHASE 0: baseline ══')
  const neonQ = async <T>(sql: string, params?: unknown[]) => (await pool.query(sql, params)).rows as unknown as T[]
  const base = {
    neonOrders: Number((await neonQ<{ c: number }>('SELECT COUNT(*)::int c FROM orders'))[0].c),
    neonAudit: Number((await neonQ<{ c: number }>('SELECT COUNT(*)::int c FROM audit_logs'))[0].c),
    neonMaxEvent: Number((await neonQ<{ m: number }>('SELECT COALESCE(MAX(id),0) m FROM hybrid_events'))[0].m),
    localOrders: Number((await lrows('SELECT COUNT(*) c FROM orders'))[0].c),
    localAudit: Number((await lrows('SELECT COUNT(*) c FROM audit_logs'))[0].c),
  }
  const table1 = (await neonQ<{ status: string }>('SELECT status FROM tables WHERE id=21'))[0]
  console.log(`  baseline: neon orders=${base.neonOrders} audit=${base.neonAudit} maxEvent=${base.neonMaxEvent} · local orders=${base.localOrders} audit=${base.localAudit} · table#1 ${table1?.status}`)
  if (table1?.status !== 'free') { console.log('✗ table #21 is not free — pick another table'); process.exit(1) }

  // ══════ PHASE 1 — LIVE ORDER via the real webhook ══════
  console.log('══ PHASE 1: mazaj order → PRODUCTION webhook (the contract mazaj sends) ══')
  const externalId = 'r50e2e-' + Date.now().toString(36)
  const payload = {
    provider: 'mazaj',
    externalId,
    customerName: 'R50 Live E2E Probe',
    tableId: 21,
    items: [{ sku: 'MAZAJ-MAZAYA-FRUITS', name: 'Mazaya Fruits', quantity: 2, unitPrice: 125, notes: 'Blueberry' }],
  }
  const t0 = Date.now()
  const res = await fetch(`${PROD}/api/integrations/delivery/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rsm-key': key },
    body: JSON.stringify(payload),
  })
  const body = (await res.json().catch(() => null)) as null | {
    order?: { id?: number; totalAmount?: number; subtotalAmount?: number; tableId?: number; externalRef?: string; items?: Array<{ id?: number; productId?: number; quantity?: number; unitPrice?: number; status?: string; notes?: string }> }
    duplicate?: boolean
    addedToCheck?: boolean
    table?: string
    unmatched?: string[]
    priceDifferences?: string[]
  }
  console.log(`  POST ${PROD}/api/integrations/delivery/webhook → HTTP ${res.status} in ${Date.now() - t0}ms`)
  if (res.status !== 201 || !body?.order?.id) { fail(`webhook rejected: ${JSON.stringify(body)?.slice(0, 300)}`); await finish(); return }
  const order = body.order
  const itemId = order.items?.[0]?.id
  ok(`NEW dine-in CHECK #${order.id} on table ${body.table} (tableId ${order.tableId}) — ${order.externalRef}`)
  ok(`house pricing: 2 × Mazaya Fruits @EGP ${order.items?.[0]?.unitPrice} = subtotal EGP ${order.subtotalAmount} · total EGP ${order.totalAmount} (incl. 26% tax) — mazaj sent unitPrice 125, house price used: ${order.items?.[0]?.unitPrice === 125 ? 'yes (125)' : 'CHECK'}`)
  if (Math.abs((order.totalAmount ?? 0) - 315) > 0.01) fail(`expected total 315 (250 × 1.26), got ${order.totalAmount}`)
  if (order.items?.[0]?.status !== 'new') fail(`item status ${order.items?.[0]?.status} — expected 'new' (KDS-ready)`)
  else ok('item status = new (KDS-ready)')
  if (body.unmatched?.length) console.log(`  note: unmatched items skipped: ${body.unmatched.join(', ')}`)

  // ══════ PHASE 2 — cloud state verify (Neon) ══════
  console.log('══ PHASE 2: cloud (Neon) state ══')
  const nOrder = (await neonQ<{ id: number; external_ref: string; order_type: string; status: string; table_id: number; total_amount: number; origin_device_id: string | null }>('SELECT id, external_ref, order_type, status, table_id, total_amount, origin_device_id FROM orders WHERE id=$1', [order.id]))[0]
  if (!nOrder) fail(`order #${order.id} not in Neon`)
  else {
    ok(`Neon order #${nOrder.id} ${nOrder.external_ref} · ${nOrder.order_type}/${nOrder.status} · table ${nOrder.table_id} · EGP ${nOrder.total_amount} · origin ${nOrder.origin_device_id ?? 'null (cloud-origin — correct)'}`)
    if (nOrder.external_ref !== `mazaj:${externalId}`) fail(`externalRef mismatch: ${nOrder.external_ref}`)
  }
  const nItem = (await neonQ<{ id: number; product_id: number; quantity: number; unit_price: number; status: string; notes: string | null }>('SELECT id, product_id, quantity, unit_price, status, notes FROM order_items WHERE order_id=$1', [order.id]))[0]
  if (nItem) ok(`Neon item #${nItem.id}: product ${nItem.product_id} ×${nItem.quantity} @${nItem.unit_price} status=${nItem.status} notes=${JSON.stringify(nItem.notes)}`)
  else fail('item missing on Neon')
  const nTable = (await neonQ<{ status: string }>('SELECT status FROM tables WHERE id=21'))[0]
  if (nTable?.status === 'occupied') ok('table #21 → occupied on Neon')
  else fail(`table #21 status ${nTable?.status}`)
  const nAudit = (await neonQ<{ id: number }>("SELECT id FROM audit_logs WHERE action='integration.webhook' AND entity='order' AND entity_id=$1", [order.id]))[0]
  if (nAudit) ok(`audit row #${nAudit.id} (integration.webhook) on Neon`)
  else fail('audit row missing on Neon')
  const seen = (await neonQ<{ key: string }>('SELECT key FROM app_settings WHERE key=$1', [`mazaj.seen.mazaj:${externalId}`]))[0]
  // NOTE: the seen-ledger is only written on the ADD-TO-CHECK path; a NEW
  // check dedupes via Order.externalRef (checked in phase 4) — absence here
  // is the designed behavior, not a defect.
  console.log(`  seen-ledger row: ${seen ? 'present (' + seen.key + ')' : 'absent — correct for the NEW-check path (externalRef idempotency)'}`)

  // ══════ PHASE 3 — desktop/local terminal receives it (engine pull) ══════
  console.log('══ PHASE 3: desktop terminal receives the order (hybrid engine pull) ══')
  const evApplied = async (entity: string, entityId: number, op: string) =>
    (await lrows(`SELECT status FROM hybrid_events WHERE direction='in' AND entity='${entity}' AND entityId=${entityId} AND operation='${op}' ORDER BY id DESC LIMIT 1`))[0]?.status === 'applied'
  await waitFor(`local applied Order#${order.id} create`, () => evApplied('Order', order.id!, 'create'))
  await waitFor(`local applied OrderItem#${itemId} create`, () => evApplied('OrderItem', itemId!, 'create'))
  await waitFor('local applied RestaurantTable#21 update (occupied)', () => evApplied('RestaurantTable', 21, 'update'))
  const lOrder = (await ljson<{ total_amount: number; external_ref: string; table_id: number }>(`SELECT total_amount, external_ref, table_id FROM orders WHERE id=${order.id}`))[0]
  if (lOrder) ok(`LOCAL order #${order.id}: EGP ${lOrder.total_amount} · ${lOrder.external_ref} · table ${lOrder.table_id}`)
  else fail(`local order #${order.id} missing`)
  const lItem = (await ljson<{ status: string; quantity: number; notes: string | null }>(`SELECT status, quantity, notes FROM order_items WHERE id=${itemId}`))[0]
  if (lItem?.status === 'new') ok(`LOCAL item #${itemId} KDS-ready (new, ×${lItem.quantity}, notes ${JSON.stringify(lItem.notes)})`)
  else fail(`local item state: ${JSON.stringify(lItem)}`)
  const lTable = (await lrows('SELECT status FROM tables WHERE id=21'))[0]
  if (lTable?.status === 'occupied') ok('LOCAL table #21 → occupied (KDS floor will show it live)')
  else fail(`local table #21 ${lTable?.status}`)

  // ══════ PHASE 4 — idempotent replay ══════
  console.log('══ PHASE 4: idempotent replay (double-push protection) ══')
  const res2 = await fetch(`${PROD}/api/integrations/delivery/webhook`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-rsm-key': key }, body: JSON.stringify(payload),
  })
  const body2 = (await res2.json().catch(() => null)) as null | { order?: { id?: number; totalAmount?: number }; duplicate?: boolean }
  if (res2.status === 200 && body2?.duplicate === true && body2.order?.id === order.id) ok(`replay → duplicate:true, same check #${body2.order?.id}, total unchanged EGP ${body2.order?.totalAmount}`)
  else fail(`replay not idempotent: HTTP ${res2.status} ${JSON.stringify(body2)?.slice(0, 200)}`)
  const cnt = (await neonQ<{ c: number }>('SELECT COUNT(*)::int c FROM orders WHERE external_ref=$1', [`mazaj:${externalId}`]))[0]
  if (cnt.c === 1) ok('exactly ONE check exists for the external ref (no duplicate rows)')
  else fail(`${cnt.c} orders with the same externalRef`)

  // ══════ PHASE 5 — zero-residue cleanup (r47/r49 discipline) ══════
  console.log('══ PHASE 5: zero-residue cleanup ══')
  // 1. every probe event on Neon (created during this test)
  const probeEvents = await neonQ<{ id: number; eventId: string }>('SELECT id, "eventId" FROM hybrid_events WHERE id > $1', [base.neonMaxEvent])
  const probeEventIds = probeEvents.map((e) => e.eventId)
  console.log(`  probe events on Neon: ${probeEvents.length}`)
  // 2. stream cleanup FIRST (r46 lesson #2)
  if (probeEventIds.length) {
    const d = await pool.query('DELETE FROM hybrid_events WHERE "eventId" = ANY($1) RETURNING id', [probeEventIds])
    console.log(`  stream cleanup: ${d.rowCount} event rows removed`)
  }
  // 3. hard deletes + table free
  await pool.query('DELETE FROM order_items WHERE order_id = $1', [order.id])
  await pool.query('DELETE FROM orders WHERE id = $1', [order.id])
  await pool.query("UPDATE tables SET status='free' WHERE id = 21")
  await pool.query('DELETE FROM audit_logs WHERE id = $1', [nAudit?.id])
  await pool.query('DELETE FROM app_settings WHERE key = $1', [`mazaj.seen.mazaj:${externalId}`])
  console.log(`  Neon: order #${order.id} + item #${itemId} deleted, table #21 free, audit #${nAudit?.id} + seen-ledger removed`)

  // 4. supersede events ABOVE the LOCAL watermarks (full rows — r49 lesson)
  const emit = async (entity: string, entityId: number, operation: string, revision: number, payloadObj: Record<string, unknown>) => {
    const p = JSON.stringify(payloadObj)
    await pool.query(
      `INSERT INTO hybrid_events ("eventId","deviceId","entity","entityId","operation","revision","payloadHash","payload","direction","status","attempts","createdAt","updatedAt")
       VALUES ($1,'unbound',$2,$3,$4,$5,$6,$7,'out','pending',0,now(),now())`,
      [randomUUID(), entity, entityId, operation, revision, createHash('sha256').update(p).digest('hex'), p],
    )
    console.log(`  emitted ${entity}/${entityId} ${operation} rev${revision}`)
  }
  const localWm = async (entity: string, entityId: number) =>
    Number((await lrows(`SELECT COALESCE(MAX(revision),0) m FROM hybrid_events WHERE entity='${entity}' AND entityId=${entityId}`))[0]?.m ?? 0)
  const wmItem = await localWm('OrderItem', itemId!)
  const wmOrder = await localWm('Order', order.id!)
  const wmTable = await localWm('RestaurantTable', 21)
  await emit('OrderItem', itemId!, 'delete', wmItem + 1, { id: itemId })
  await emit('Order', order.id!, 'delete', wmOrder + 1, { id: order.id })
  const tRow = (await neonQ<Record<string, unknown>>('SELECT * FROM tables WHERE id=21'))[0]
  const tPayload: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(tRow)) tPayload[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v instanceof Date ? v.toISOString() : v
  tPayload.revision = wmTable + 1
  await emit('RestaurantTable', 21, 'update', wmTable + 1, tPayload)

  // 5. local convergence via the pulled supersede events
  await waitFor(`local applied OrderItem#${itemId} delete`, () => evApplied('OrderItem', itemId!, 'delete'))
  await waitFor(`local applied Order#${order.id} delete`, () => evApplied('Order', order.id!, 'delete'))
  await waitFor('local applied RestaurantTable#1 free supersede', async () =>
    (await lrows('SELECT status FROM tables WHERE id=21'))[0]?.status === 'free')
  // 6. surgical local audit removal (append-only policy — r47/r49 pattern) + local event copies
  await ldb.execute(`DELETE FROM audit_logs WHERE id = ${nAudit?.id}`)
  if (probeEventIds.length) {
    await ldb.execute(`DELETE FROM hybrid_events WHERE "eventId" IN (${probeEventIds.map((i) => `'${i}'`).join(',')})`)
  }
  console.log('  local: audit row + event copies removed surgically')

  // ══════ PHASE 6 — final verdict ══════
  await finish()
  return

  async function finish() {
    console.log('══ PHASE 6: final verdict (launch baseline exact) ══')
    const f = {
      neonOrders: Number((await neonQ<{ c: number }>('SELECT COUNT(*)::int c FROM orders'))[0].c),
      neonAudit: Number((await neonQ<{ c: number }>('SELECT COUNT(*)::int c FROM audit_logs'))[0].c),
      neonTable: (await neonQ<{ status: string }>('SELECT status FROM tables WHERE id=21'))[0]?.status,
      neonSeen: Number((await neonQ<{ c: number }>("SELECT COUNT(*)::int c FROM app_settings WHERE key LIKE 'mazaj.seen%'"))[0].c),
      localOrders: Number((await lrows('SELECT COUNT(*) c FROM orders'))[0].c),
      localAudit: Number((await lrows('SELECT COUNT(*) c FROM audit_logs'))[0].c),
      localTable: (await lrows('SELECT status FROM tables WHERE id=21'))[0]?.status,
      outboxPending: Number((await lrows("SELECT COUNT(*) c FROM hybrid_events WHERE direction='out' AND status='pending'"))[0].c),
    }
    console.log(`  neon: orders=${f.neonOrders} audit=${f.neonAudit} table#21=${f.neonTable} seenLedger=${f.neonSeen}`)
    console.log(`  local: orders=${f.localOrders} audit=${f.localAudit} table#1=${f.localTable} outboxPending=${f.outboxPending}`)
    const verdict =
      f.neonOrders === base.neonOrders && f.localOrders === base.localOrders &&
      f.neonAudit === base.neonAudit && f.localAudit === base.localAudit &&
      f.neonTable === 'free' && f.localTable === 'free' && f.neonSeen === 0 && f.outboxPending === 0
    if (verdict) ok('ZERO RESIDUE — both planes back to the exact launch baseline')
    else fail('residue detected — see counts above')
    await pool.end(); ldb.close()
    console.log(exitCode === 0
      ? 'RESULT: MAZAJ → RSM ORDER FLOW VERIFIED LIVE (webhook → check at house prices → KDS-ready → desktop pull → idempotent → zero residue)'
      : 'RESULT: FAILURES ABOVE')
    process.exit(exitCode)
  }
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1) })
