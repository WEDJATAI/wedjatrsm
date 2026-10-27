// E2E proof — the downloaded desktop platform, LIVE (see todo 3-f)
import { Pool } from 'pg'
import { readFileSync, writeFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('/home/z/my-project/.env.deploy-local', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
// dynamic — the platform binds the first free port (3000..3020)
const DASH = 'http://127.0.0.1:9753'
let LOCAL = '' // resolved from the dashboard's platform state
const pool = new Pool({ connectionString: env.NEON_DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const ok = (c: boolean, l: string, extra?: string) => {
  console.log(`  ${c ? '✓' : '✗ FAIL'} — ${l}${extra ? ` · ${extra}` : ''}`)
  if (!c) failed++
}

console.log(`\n[E2E] waiting for the supervised platform (production mode)  ·  ${new Date().toISOString()}`)
let plat: any = null
for (let i = 0; i < 110; i++) {
  try {
    const s = await (await fetch(`${DASH}/api/state`)).json()
    if (s.platform?.status === 'running') { plat = s.platform; break }
    if (s.platform?.status === 'error') { console.log('  platform error:', s.platform.lastError); break }
  } catch { /* not up yet */ }
  await sleep(3000)
}
ok(!!plat, `platform RUNNING (mode=${plat?.mode}, port=${plat?.port}, runtime=${plat?.runtime})`)
LOCAL = `http://127.0.0.1:${plat?.port}`
ok(plat?.provisioned === true && plat?.enrolled === true, `provisioned + enrolled (device ${String(plat?.deviceId).slice(0, 8)}…)`)

for (let i = 0; i < 10; i++) {
  try {
    const s = await (await fetch(`${DASH}/api/state`)).json()
    if (s.platform?.sync?.healthy !== null && s.platform?.sync?.healthy !== undefined) { plat = s.platform; break }
  } catch { /* retry */ }
  await sleep(2000)
}
const sy = plat?.sync ?? {}
ok(sy.healthy === true, `two-way sync LIVE (engine=${sy.engine}, paused=${sy.paused})`, sy.error ?? '')
ok(sy.cloudReachable === 'yes', `cloud reachable: ${sy.cloudReachable}`)
console.log(`    lastPush ${sy.lastPushAt} · lastPull ${sy.lastPullAt} · queue ${sy.pendingUploads}up/${sy.pendingDownloads}down · device "${sy.deviceName}"`)

console.log(`\n[UP] desktop platform → cloud  ·  ${new Date().toISOString()}`)
const login = await fetch(`${LOCAL}/api/auth/developer-login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: '180787' }),
})
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
ok(login.status === 200, `developer session on the DESKTOP platform (${login.status})`, (await login.text().catch(() => '')).slice(0, 120))

const A = await fetch(`${LOCAL}/api/orders`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ orderType: 'takeaway', items: [{ productId: 1168, quantity: 1 }] }),
}).then((r) => r.json())
const orderA = A?.order?.id as number
ok(orderA > 0, `desktop-platform takeaway order #${orderA} created (1x Small Water)`, JSON.stringify(A?.error ?? ''))

await sleep(4000)
const sync1 = await fetch(`${LOCAL}/api/hybrid/sync-now`, { method: 'POST', headers: { cookie } }).then((r) => r.json()).catch(() => null)
ok(!!sync1 && !sync1?.error, `sync-now on the desktop platform (pushed ${sync1?.push?.pushed ?? '?'} · acked ${sync1?.push?.acked ?? '?'})`, JSON.stringify(sync1?.error ?? ''))

let cloudA: any = null
for (let i = 0; i < 20; i++) {
  cloudA = (await pool.query(`SELECT id, status, order_type FROM orders WHERE id=$1`, [orderA])).rows[0] ?? null
  if (cloudA) break
  await sleep(3000)
  await fetch(`${LOCAL}/api/hybrid/sync-now`, { method: 'POST', headers: { cookie } }).catch(() => null)
}
ok(!!cloudA, `cloud Neon HAS order #${orderA} pushed by the desktop platform (status=${cloudA?.status}, ${cloudA?.order_type})`)
const items = Number((await pool.query(`SELECT COUNT(*) FROM order_items WHERE order_id=$1`, [orderA])).rows[0].count)
ok(items === 1, `cloud order_items ${items}/1`)
const audits = Number((await pool.query(`SELECT COUNT(*) FROM audit_logs WHERE entity='order' AND entity_id=$1`, [orderA])).rows[0].count)
ok(audits >= 1, `cloud order audits ${audits} (order.create)`)

const cancelA = await fetch(`${LOCAL}/api/orders/${orderA}/cancel`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ reason: 'r58 desktop-download E2E probe' }),
})
ok(cancelA.status === 200, `desktop cancel #${orderA} (${cancelA.status})`)
await sleep(4000)
for (let i = 0; i < 20; i++) {
  cloudA = (await pool.query(`SELECT status FROM orders WHERE id=$1`, [orderA])).rows[0] ?? null
  if (cloudA?.status === 'cancelled') break
  await sleep(3000)
  await fetch(`${LOCAL}/api/hybrid/sync-now`, { method: 'POST', headers: { cookie } }).catch(() => null)
}
ok(cloudA?.status === 'cancelled', `cloud sees the CANCEL (status=${cloudA?.status})`)

writeFileSync('/tmp/verify-2way-e2e.json', JSON.stringify({ orderA }, null, 2))
console.log(`\n${failed === 0 ? 'E2E PROOF COMPLETE' : `${failed} FAILURES`} — probe id ${orderA} (purge next)`)
await pool.end()
process.exit(failed === 0 ? 0 : 1)
