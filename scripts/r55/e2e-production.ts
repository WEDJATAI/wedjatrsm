// r55 — PRODUCTION E2E against https://wedjatrsm.vercel.app (the real mazaj
// target): webhook order → local terminal pulls it DOWN → PIN-gated revoke
// on production → local pulls the cancel → both planes verified.
import { readFileSync, writeFileSync } from 'fs'
import { Database } from 'bun:sqlite'
const KEY = readFileSync('/tmp/prod-key.txt', 'utf8').trim()
const BASE = 'https://wedjatrsm.vercel.app'
let failed = 0
const ok = (c: boolean, l: string, x?: string) => { console.log(`  ${c ? '✓' : '✗ FAIL'} — ${l}${x ? ` · ${x}` : ''}`); if (!c) failed++ }
const ext = `r55prod-${Date.now().toString(36)}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main() {
  console.log(`[r55-prod-e2e] probe ${ext} against ${BASE}`)

  // 1. mazaj webhook → PRODUCTION (creates on Neon)
  const A = await fetch(`${BASE}/api/integrations/delivery/webhook`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-rsm-key': KEY },
    body: JSON.stringify({
      provider: 'mazaj', externalId: ext, customerName: 'Prod E2E Guest',
      items: [{ sku: 'MAZAJ-MAZAYA-FRUITS', quantity: 1 }],
    }),
  })
  const AB = await A.json().catch(() => null)
  ok(A.status === 201 && AB?.order?.id > 0, `production webhook 201 → order #${AB?.order?.id} on the cloud`, `HTTP ${A.status}`)
  const orderId = AB?.order?.id as number
  ok(Math.abs((AB?.order?.totalAmount ?? 0) - 157.5) < 0.01, 'house price 125 + 26% = 157.50', `got ${AB?.order?.totalAmount}`)

  // 2. the revoke endpoint exists on production + PIN enforcement
  const noPin = await fetch(`${BASE}/api/integrations/mazaj/revoke`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-rsm-key': KEY },
    body: JSON.stringify({ externalId: ext, reason: 'no pin' }),
  })
  ok(noPin.status === 400, `missing PIN → 400 on production (${noPin.status})`)
  const wrong = await fetch(`${BASE}/api/integrations/mazaj/revoke`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-rsm-key': KEY },
    body: JSON.stringify({ externalId: ext, pin: '000000', reason: 'wrong pin' }),
  })
  ok(wrong.status === 401, `wrong PIN → 401 on production (${wrong.status})`)

  // 3. valid revoke (Amira's PIN) on PRODUCTION
  const R = await fetch(`${BASE}/api/integrations/mazaj/revoke`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-rsm-key': KEY },
    body: JSON.stringify({ externalId: ext, pin: '112233', reason: 'Production E2E — guest cancelled', operator: 'Mazaj Admin' }),
  })
  const RB = await R.json().catch(() => null)
  ok(R.status === 200 && RB?.revoke?.mode === 'cancelled', `production revoke 200 mode=cancelled (${R.status})`)
  ok(RB?.revoke?.authorizedBy === 'Amira', `authorizedBy Amira (${RB?.revoke?.authorizedBy})`)

  // 4. wait for the LOCAL terminal to pull the whole chain DOWN
  console.log('  waiting for the desktop engine to pull the production chain…')
  let localOrder = null as any
  for (let i = 0; i < 16; i++) {
    await sleep(15000)
    const local = new Database('/home/z/my-project/db/custom.db', { readonly: true })
    localOrder = local.query(`SELECT id, status, external_ref FROM orders WHERE external_ref=?`).get(ext) ?? null
    local.close()
    if (localOrder) break
  }
  ok(!!localOrder, `desktop pulled order #${localOrder?.id} (externalRef mazaj:${ext})`)
  let cancelled = false
  for (let i = 0; i < 12; i++) {
    await sleep(15000)
    const local = new Database('/home/z/my-project/db/custom.db', { readonly: true })
    localOrder = local.query(`SELECT id, status FROM orders WHERE external_ref=?`).get(ext) ?? null
    const audit = local.query(`SELECT id FROM audit_logs WHERE action='integration.mazajRevoke' AND entity_id=${orderId}`).get()
    local.close()
    if (localOrder?.status === 'cancelled' && audit) { cancelled = true; break }
  }
  ok(cancelled, `desktop pulled the CANCEL + revoke audit (status=${localOrder?.status})`)

  writeFileSync('/tmp/r55-prod-probe.json', JSON.stringify({ ext, orderId }))
  console.log(failed === 0 ? '\nPRODUCTION E2E PASS — mazaj → cloud → desktop + PIN revoke end-to-end' : `\n${failed} FAILURE(S)`)
  process.exit(failed === 0 ? 0 : 1)
}
main().catch((e) => { console.error('FATAL', e); process.exit(1) })
