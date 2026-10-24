// verify-2way — phase 2: finish the UP-direction test (organic cancel of
// probe order 2215 through the engine → verified on Neon) using the CORRECT
// endpoints + the CORRECT bun:sqlite parameter API (.get(p), never a second
// query() arg — silently ignored, see worklog trap note). Then the companion
// purge script cleans both probes zero-residue.
import { Pool } from 'pg'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'fs'
const env = Object.fromEntries(
  readFileSync('.env.deploy-local', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const LOCAL = 'http://localhost:3000'
const ORDER_A = 2215 // local takeaway probe (open)
let failed = 0
const ok = (c: boolean, l: string, extra?: string) => {
  console.log(`  ${c ? '✓' : '✗ FAIL'} — ${l}${extra ? ` · ${extra}` : ''}`)
  if (!c) failed++
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const pool = new Pool({ connectionString: env.NEON_DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 })

const login = await fetch(`${LOCAL}/api/auth/developer-login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: '180787' }),
})
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
ok(login.status === 200, 'developer session')

// organic cancel through the API (the real POS path)
const cancel = await fetch(`${LOCAL}/api/orders/${ORDER_A}/cancel`, {
  method: 'POST', headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ reason: 'verify-2way probe' }),
})
ok(cancel.status === 200, `local cancel #${ORDER_A} via POST /cancel (${cancel.status})`)

// engine push → cloud
await sleep(4000)
let cloud: any = null
for (let i = 0; i < 20; i++) {
  await fetch(`${LOCAL}/api/hybrid/sync-now`, { method: 'POST', headers: { cookie } }).catch(() => null)
  await sleep(3000)
  cloud = (await pool.query(`SELECT status FROM orders WHERE id=$1`, [ORDER_A])).rows[0] ?? null
  if (cloud?.status === 'cancelled') break
}
ok(cloud?.status === 'cancelled', `cloud Neon sees the CANCEL (status=${cloud?.status})`)

const cloudAudits = Number((await pool.query(`SELECT COUNT(*) FROM audit_logs WHERE entity='order' AND entity_id=$1`, [ORDER_A])).rows[0].count)
ok(cloudAudits >= 2, `cloud order audits ${cloudAudits} (create + cancel)`)

// local sanity with the CORRECT param API
const db = new Database('/home/z/my-project/db/custom.db', { readonly: true })
const localRow = db.query(`SELECT status FROM orders WHERE id=?`).get(ORDER_A) as any
db.close()
ok(localRow?.status === 'cancelled', `local #${ORDER_A} cancelled (${localRow?.status})`)

await pool.end()
console.log(failed === 0 ? `\nUP-DIRECTION COMPLETE — create + cancel both organically pushed` : `\n${failed} FAILURE(S)`)
process.exit(failed === 0 ? 0 : 1)
