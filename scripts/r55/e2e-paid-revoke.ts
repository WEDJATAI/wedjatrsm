// r55 — E2E phase E2: the PAID-path mazaj revoke (payment reversal).
import { Database } from 'bun:sqlite'
const KEY = (() => {
  const local = new Database('/home/z/my-project/db/custom.db', { readonly: true })
  const v = (local.query(`SELECT value FROM app_settings WHERE key='deliveryWebhookKey'`).get() as any).value
  local.close(); return v
})()
const BASE = 'http://localhost:3000'
let failed = 0
const ok = (cond: boolean, label: string, extra?: string) => {
  console.log(`  ${cond ? '✓' : '✗ FAIL'} — ${label}${extra ? ` · ${extra}` : ''}`)
  if (!cond) failed++
}
const stamp = Date.now().toString(36)
const ext = `r55e2e-c-${stamp}`
let cookie = ''

async function main() {
  const B = await fetch(`${BASE}/api/integrations/delivery/webhook`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-rsm-key': KEY },
    body: JSON.stringify({
      provider: 'mazaj', externalId: ext, customerName: 'Mazaj E2E Guest C',
      items: [{ sku: 'MAZAJ-MAZAYA-MIX', quantity: 1 }],
    }),
  }).then((r) => r.json())
  const orderId = B.order?.id as number
  ok(orderId > 0, `webhook 201, order #${orderId}, total ${B.order?.totalAmount}`)

  const login = await fetch(`${BASE}/api/auth/developer-login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: '180787' }),
  })
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
  const pay = await fetch(`${BASE}/api/orders/${orderId}/payments`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ payments: [{ method: 'cash', amount: 182.7, amountTendered: 200, changeGiven: 17.3 }] }),
  })
  const payBody = await pay.json().catch(() => null)
  ok(pay.status === 200, `payment recorded (${pay.status})`, JSON.stringify(payBody?.error ?? 'ok'))
  const paid = await fetch(`${BASE}/api/orders/${orderId}`, { headers: { cookie } }).then((r) => r.json())
  ok(paid.order?.status === 'paid', `order #${orderId} paid (${paid.order?.status})`)

  const R = await fetch(`${BASE}/api/integrations/mazaj/revoke`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-rsm-key': KEY },
    body: JSON.stringify({ externalId: ext, pin: '112233', reason: 'Guest refund — paid in error', operator: 'Mazaj Admin — E2E' }),
  }).then((r) => r.json())
  ok(R.revoke?.mode === 'payment-revoked', `revoke mode=payment-revoked (${R.revoke?.mode})`)
  ok(Math.abs((R.revoke?.amount ?? 0) - 182.7) < 0.01, `reversed −182.70 (${R.revoke?.amount})`)
  ok(R.order?.status === 'revoked', `order status=revoked (${R.order?.status})`)

  const local = new Database('/home/z/my-project/db/custom.db', { readonly: true })
  const neg = local.query(`SELECT amount, reference FROM payments WHERE order_id=? ORDER BY id DESC LIMIT 1`).get(orderId) as any
  ok(neg && neg.amount < 0 && /mazaj-revoke/.test(neg.reference ?? ''), `negative Payment row (${neg?.amount}, "${neg?.reference?.slice(0, 40)}")`)
  const audit = local.query(`SELECT details FROM audit_logs WHERE action='integration.mazajRevoke' AND entity_id=${orderId}`).get() as any
  ok(!!audit && /payment revoked/.test(audit.details) && /Amira/.test(audit.details), 'audit: payment revoked, authorized by Amira')
  local.close()

  console.log(failed === 0 ? '\nPAID-PATH PASS' : `\n${failed} FAILURE(S)`)
  console.log(JSON.stringify({ ext, orderId }))
  process.exit(failed === 0 ? 0 : 1)
}
main().catch((e) => { console.error('FATAL', e); process.exit(1) })
