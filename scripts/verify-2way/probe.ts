// verify-2way — the owner's standing directive: prove the DESKTOP ↔ CLOUD
// 2-way sync is working, live, on the real system.
//
//   UP   (desktop → cloud): local API creates a takeaway probe order →
//        organic engine push (sync-now forced) → verified on Neon.
//   DOWN (cloud → desktop): production mazaj webhook (the REAL Vercel
//        deployment) creates an order on Neon → PIN-gated revoke releases
//        it → engine pull (sync-now forced) → verified in local SQLite.
//
// Financial residue: NONE by design (create+cancel / webhook+revoke — no
// payments are recorded). The purge companion script removes both probes
// zero-residue afterwards. Real business data (order 2214 — Karim's
// cancelled live check) is never touched.
import { Pool } from 'pg'
import { Database } from 'bun:sqlite'
import { writeFileSync } from 'node:fs'
import { readFileSync } from 'fs'
const env = Object.fromEntries(
  readFileSync('.env.deploy-local', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const LOCAL = 'http://localhost:3000'
const PROD = env.VERCEL_PROD_URL.replace(/\/$/, '')
const KEY = (() => {
  const db = new Database('/home/z/my-project/db/custom.db', { readonly: true })
  const v = (db.query(`SELECT value FROM app_settings WHERE key='deliveryWebhookKey'`).get() as any).value
  db.close(); return v
})()
const stamp = Date.now().toString(36)
const ext = `verify2way-${stamp}`
let failed = 0
const ok = (c: boolean, l: string, extra?: string) => {
  console.log(`  ${c ? '✓' : '✗ FAIL'} — ${l}${extra ? ` · ${extra}` : ''}`)
  if (!c) failed++
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const pool = new Pool({ connectionString: env.NEON_DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 })
let cookie = ''

// ───────────────────────── UP: desktop → cloud ─────────────────────────
console.log(`\n[UP] desktop → cloud (organic engine push)  ·  ${new Date().toISOString()}`)

const login = await fetch(`${LOCAL}/api/auth/developer-login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: '180787' }),
})
cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
ok(login.status === 200, 'developer session')

const A = await fetch(`${LOCAL}/api/orders`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ orderType: 'takeaway', items: [{ productId: 1168, quantity: 1 }] }),
}).then((r) => r.json())
const orderA = A?.order?.id as number
ok(orderA > 0, `local takeaway order #${orderA} created (1× Small Water)`, JSON.stringify(A?.error ?? ''))

// let the engine tick organically first, then force a cycle
await sleep(4000)
const sync1 = await fetch(`${LOCAL}/api/hybrid/sync-now`, { method: 'POST', headers: { cookie } }).then((r) => r.json()).catch(() => null)
ok(!!sync1 && !sync1?.error, `sync-now cycle (pushed ${sync1?.push?.pushed ?? '?'} · acked ${sync1?.push?.acked ?? '?'})`, JSON.stringify(sync1?.error ?? ''))

// wait for the push to land on Neon (engine acks after the cloud accepts)
let cloudA: any = null
for (let i = 0; i < 20; i++) {
  cloudA = (await pool.query(`SELECT id, status, total_amount, order_type FROM orders WHERE id=$1`, [orderA])).rows[0] ?? null
  if (cloudA) break
  await sleep(3000)
  await fetch(`${LOCAL}/api/hybrid/sync-now`, { method: 'POST', headers: { cookie } }).catch(() => null)
}
ok(!!cloudA, `cloud Neon HAS order #${orderA} (status=${cloudA?.status}, ${cloudA?.order_type})`)
const cloudAItems = Number((await pool.query(`SELECT COUNT(*) FROM order_items WHERE order_id=$1`, [orderA])).rows[0].count)
ok(cloudAItems === 1, `cloud order_items ${cloudAItems}/1`)
const cloudAAudits = Number((await pool.query(`SELECT COUNT(*) FROM audit_logs WHERE entity='order' AND entity_id=$1`, [orderA])).rows[0].count)
ok(cloudAAudits >= 1, `cloud order audits ${cloudAAudits} (order.create)`)

// cancel locally (organic path — tests the cancel event through the engine)
// (r55 trap: DELETE /api/orders/[id] → 405; the cancel route is POST …/cancel)
const cancelA = await fetch(`${LOCAL}/api/orders/${orderA}/cancel`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ reason: 'verify-2way probe' }),
})
ok(cancelA.status === 200, `local cancel #${orderA} (${cancelA.status})`)
await sleep(4000)
for (let i = 0; i < 20; i++) {
  cloudA = (await pool.query(`SELECT status FROM orders WHERE id=$1`, [orderA])).rows[0] ?? null
  if (cloudA?.status === 'cancelled') break
  await sleep(3000)
  await fetch(`${LOCAL}/api/hybrid/sync-now`, { method: 'POST', headers: { cookie } }).catch(() => null)
}
ok(cloudA?.status === 'cancelled', `cloud sees the CANCEL (status=${cloudA?.status})`)

// ─────────────────────── DOWN: cloud → desktop ───────────────────────
console.log(`\n[DOWN] cloud → desktop (production webhook + engine pull)  ·  ${new Date().toISOString()}`)

const W = await fetch(`${PROD}/api/integrations/delivery/webhook`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-rsm-key': KEY },
  body: JSON.stringify({
    provider: 'mazaj', externalId: ext, customerName: 'Verify 2Way Probe',
    items: [{ sku: 'MAZAJ-MAZAYA-MIX', quantity: 1 }],
  }),
}).then((r) => r.json()).catch(() => null)
const orderB = W?.order?.id as number
ok(orderB > 0, `PRODUCTION webhook 201 → order #${orderB} on Neon (total ${W?.order?.totalAmount})`, JSON.stringify(W?.error ?? ''))

// PIN-gated revoke on production (organic cancel + table release)
const R = await fetch(`${PROD}/api/integrations/mazaj/revoke`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-rsm-key': KEY },
  body: JSON.stringify({ externalId: ext, pin: '112233', reason: 'verify-2way probe release', operator: 'Verify 2Way' }),
}).then((r) => r.json()).catch(() => null)
ok(R?.revoke?.mode === 'cancelled', `production PIN revoke 200 mode=cancelled (${R?.revoke?.mode})`, JSON.stringify(R?.error ?? ''))
ok(R?.revoke?.authorizedBy === 'Amira', `authorizedBy=${R?.revoke?.authorizedBy} (staff PIN)`)

// pull the chain down to the desktop
let localB: any = null
for (let i = 0; i < 24; i++) {
  await fetch(`${LOCAL}/api/hybrid/sync-now`, { method: 'POST', headers: { cookie } }).catch(() => null)
  await sleep(4000)
  const db = new Database('/home/z/my-project/db/custom.db', { readonly: true })
  localB = db.query(`SELECT id, status, external_ref FROM orders WHERE external_ref=?`).get(`mazaj:${ext}`) ?? null
  db.close()
  if (localB && localB.status === 'cancelled') break
}
ok(!!localB, `desktop PULLED order #${localB?.id} (externalRef mazaj:${ext})`)
ok(localB?.status === 'cancelled', `desktop sees status=${localB?.status} (revoke applied)`)

const dbL = new Database('/home/z/my-project/db/custom.db', { readonly: true })
const auditB = dbL.query(`SELECT id, details FROM audit_logs WHERE action='integration.mazajRevoke' AND entity_id=${orderB}`).get() as any
dbL.close()
ok(!!auditB, `desktop pulled the mazajRevoke audit (${auditB?.details?.slice(0, 50)}…)`)

writeFileSync('/tmp/verify-2way.json', JSON.stringify({ ext, orderA, orderB, stamp }))
await pool.end()
console.log(failed === 0 ? `\n2-WAY SYNC VERIFIED LIVE — both directions on the real system` : `\n${failed} FAILURE(S)`)
process.exit(failed === 0 ? 0 : 1)
