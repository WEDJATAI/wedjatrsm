// r55 — LIVE E2E: the mazaj ↔ RSM 2-way bridge + the PIN-gated revoke,
// on the freshly wiped system (live starts from now — zero order data).
//
// CHAIN (all against the LOCAL terminal, dev :3000):
//   A. mazaj webhook → dine-in shisha order on table 21 (mazaj → RSM)
//   B. revoke endpoint NEGATIVE tests: missing PIN → 400, wrong PIN → 401
//   C. revoke with Amira's staff PIN (112233) → organic CANCEL + table freed
//   D. replay → duplicate:true (idempotent)
//   E. second order → PAID via the payments API → revoke (paid path) →
//      negative payment + status 'revoked'
//   F. wait engine push → verify BOTH orders' final states on NEON
//      (desktop → cloud UP direction)
//   G. zero-residue purge of both probes (the r47/r55 wipe pattern)
import { readFileSync } from 'fs'
import { Database } from 'bun:sqlite'
const KEY = (() => {
  const local = new Database('/home/z/my-project/db/custom.db', { readonly: true })
  const v = (local.query(`SELECT value FROM app_settings WHERE key='deliveryWebhookKey'`).get() as any).value
  local.close()
  return v
})()
const BASE = 'http://localhost:3000'
let failed = 0
const ok = (cond: boolean, label: string, extra?: string) => {
  console.log(`  ${cond ? '✓' : '✗ FAIL'} — ${label}${extra ? ` · ${extra}` : ''}`)
  if (!cond) failed++
}
const stamp = Date.now().toString(36)
const extA = `r55e2e-a-${stamp}`
const extB = `r55e2e-b-${stamp}`
let cookie = ''

async function api(path: string, init: RequestInit = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
  })
  let body: any = null
  try { body = await res.json() } catch {}
  return { status: res.status, body }
}

async function main() {
  console.log(`[r55-e2e] probes: ${extA} (open→cancel) ${extB} (paid→revoke)`)

  // ── A. mazaj webhook → dine-in order on table 21 ──
  console.log('A. mazaj webhook → dine-in shisha order (table 21)')
  const A = await api('/api/integrations/delivery/webhook', {
    method: 'POST',
    headers: { 'x-rsm-key': KEY },
    body: JSON.stringify({
      provider: 'mazaj', externalId: extA, customerName: 'Mazaj E2E Guest A',
      tableId: 21,
      items: [{ sku: 'MAZAJ-MAZAYA-FRUITS', quantity: 2, notes: 'extra hose' }],
    }),
  })
  ok(A.status === 201 && A.body?.order?.id > 0, `webhook 201, order #${A.body?.order?.id}`)
  ok(A.body?.addedToCheck === false && A.body?.table === '1', 'new dine-in check on table "1" (id 21)')
  ok(Math.abs((A.body?.order?.totalAmount ?? 0) - 315) < 0.01, 'house price 125 ×2 + 26% tax = 315', `got ${A.body?.order?.totalAmount}`)
  const orderIdA = A.body?.order?.id as number

  // ── B. revoke negative tests ──
  console.log('B. revoke endpoint — PIN enforcement')
  const noPin = await api('/api/integrations/mazaj/revoke', {
    method: 'POST', headers: { 'x-rsm-key': KEY },
    body: JSON.stringify({ externalId: extA, reason: 'missing pin test' }),
  })
  ok(noPin.status === 400 && /PIN is required/.test(noPin.body?.error ?? ''), 'missing PIN → 400 "staff PIN is required"')
  const badKey = await api('/api/integrations/mazaj/revoke', {
    method: 'POST', headers: { 'x-rsm-key': 'wrong-key-0000000000000000' },
    body: JSON.stringify({ externalId: extA, pin: '112233', reason: 'bad key' }),
  })
  ok(badKey.status === 401, 'wrong webhook key → 401')
  const wrongPin = await api('/api/integrations/mazaj/revoke', {
    method: 'POST', headers: { 'x-rsm-key': KEY },
    body: JSON.stringify({ externalId: extA, pin: '999999', reason: 'wrong pin test' }),
  })
  ok(wrongPin.status === 401 && /Invalid staff PIN/.test(wrongPin.body?.error ?? ''), 'wrong PIN → 401 "Invalid staff PIN"')
  const noReason = await api('/api/integrations/mazaj/revoke', {
    method: 'POST', headers: { 'x-rsm-key': KEY },
    body: JSON.stringify({ externalId: extA, pin: '112233' }),
  })
  ok(noReason.status === 400 && /reason is required/.test(noReason.body?.error ?? ''), 'missing reason → 400')

  // ── C. valid revoke (open order → organic cancel + table freed) ──
  console.log('C. revoke with Amira\'s staff PIN → cancel')
  const C = await api('/api/integrations/mazaj/revoke', {
    method: 'POST', headers: { 'x-rsm-key': KEY },
    body: JSON.stringify({ externalId: extA, pin: '112233', reason: 'Guest cancelled the shisha', operator: 'Mazaj Admin — E2E' }),
  })
  ok(C.status === 200 && C.body?.revoke?.mode === 'cancelled', 'revoke 200, mode=cancelled')
  ok(C.body?.revoke?.authorizedBy === 'Amira', `authorizedBy=Amira (${C.body?.revoke?.authorizedBy})`)
  ok(C.body?.order?.status === 'cancelled', 'order status=cancelled')

  // ── D. idempotent replay ──
  console.log('D. replay → duplicate')
  const D = await api('/api/integrations/mazaj/revoke', {
    method: 'POST', headers: { 'x-rsm-key': KEY },
    body: JSON.stringify({ externalId: extA, pin: '112233', reason: 'replay test' }),
  })
  ok(D.status === 200 && D.body?.duplicate === true && D.body?.order?.status === 'cancelled', 'replay 200 duplicate:true, still cancelled')

  // table 21 freed?
  const local = new Database('/home/z/my-project/db/custom.db', { readonly: true })
  const t21 = local.query(`SELECT status FROM tables WHERE id=21`).get() as any
  ok(t21?.status === 'free', `table 21 freed after cancel (${t21?.status})`)
  const auditA = local.query(`SELECT details FROM audit_logs WHERE action='integration.mazajRevoke' AND entity_id=?`, [orderIdA]).get() as any
  ok(!!auditA && /Amira/.test(auditA.details) && /Mazaj Admin/.test(auditA.details), 'audit row: authorized by Amira, operator recorded')

  // ── E. second order → PAY → revoke (paid path) ──
  console.log('E. paid order → revoke (payment reversal)')
  const B = await api('/api/integrations/delivery/webhook', {
    method: 'POST', headers: { 'x-rsm-key': KEY },
    body: JSON.stringify({
      provider: 'mazaj', externalId: extB, customerName: 'Mazaj E2E Guest B',
      items: [{ sku: 'MAZAJ-MAZAYA-MIX', quantity: 1 }],
    }),
  })
  ok(B.status === 201, `webhook 201, order #${B.body?.order?.id}`)
  const orderIdB = B.body?.order?.id as number
  ok(Math.abs((B.body?.order?.totalAmount ?? 0) - 182.7) < 0.01, '145 + 26% = 182.70', `got ${B.body?.order?.totalAmount}`)

  // login for the payment (developer session)
  const login = await fetch(`${BASE}/api/auth/developer-login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: '180787' }),
  })
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  ok(!!cookie, 'developer session minted')
  const pay = await api(`/api/orders/${orderIdB}/payments`, {
    method: 'POST', body: JSON.stringify({ method: 'cash', amount: 182.7, amountTendered: 200, changeGiven: 17.3 }),
  })
  ok(pay.status === 200 || pay.status === 201, `payment recorded (${pay.status})`, JSON.stringify(pay.body ?? {}).slice(0, 120))
  const paid = await api(`/api/orders/${orderIdB}`)
  ok(paid.body?.order?.status === 'paid', 'order B paid')

  const R = await api('/api/integrations/mazaj/revoke', {
    method: 'POST', headers: { 'x-rsm-key': KEY },
    body: JSON.stringify({ externalId: extB, pin: '112233', reason: 'Guest refund — paid in error', operator: 'Mazaj Admin — E2E' }),
  })
  ok(R.status === 200 && R.body?.revoke?.mode === 'payment-revoked', 'revoke 200, mode=payment-revoked')
  ok(Math.abs((R.body?.revoke?.amount ?? 0) - 182.7) < 0.01, 'reversed −182.70', `got ${R.body?.revoke?.amount}`)
  ok(R.body?.order?.status === 'revoked', 'order status=revoked')
  const negPayment = local.query(`SELECT amount, reference FROM payments WHERE order_id=? ORDER BY id DESC LIMIT 1`, [orderIdB]).get() as any
  ok(negPayment && negPayment.amount < 0 && /mazaj-revoke/.test(negPayment.reference ?? ''), 'negative Payment row with mazaj-revoke reference')
  local.close()

  console.log(failed === 0 ? '\n[r55-e2e] LOCAL PHASE ALL PASS' : `\n[r55-e2e] ${failed} FAILURE(S)`)
  console.log(JSON.stringify({ extA, extB, orderIdA, orderIdB }, null, 0))
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })
