// r55 — verify the DESKTOP → CLOUD direction: the three E2E probe orders
// (2210 cancelled, 2211 cancelled, 2212 paid→revoked) + their payments,
// negative payment, audits and outbox events landed on Neon through the
// engine push (the organic path — no direct writes).
import { Pool } from 'pg'
import { readFileSync } from 'fs'
const env = Object.fromEntries(
  readFileSync('.env.deploy-local', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const pool = new Pool({ connectionString: env.NEON_DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 })
let failed = 0
const ok = (c: boolean, l: string) => { console.log(`  ${c ? '✓' : '✗ FAIL'} — ${l}`); if (!c) failed++ }

const orders = await pool.query(`SELECT id, status, external_ref FROM orders WHERE id IN (2210, 2211, 2212) ORDER BY id`)
const byId = new Map(orders.rows.map((r: any) => [r.id, r]))
ok(byId.get(2210)?.status === 'cancelled', `cloud #2210 cancelled (mazaj revoke) — ext ${byId.get(2210)?.external_ref?.slice(0, 20)}`)
ok(byId.get(2211)?.status === 'cancelled', 'cloud #2211 cancelled')
ok(byId.get(2212)?.status === 'revoked', 'cloud #2212 revoked (payment reversed)')
const items = await pool.query(`SELECT COUNT(*) FROM order_items WHERE order_id IN (2210,2211,2212)`)
ok(Number(items.rows[0].count) === 3, `cloud order_items for probes: ${items.rows[0].count}/3`)
const pays = await pool.query(`SELECT id, amount, reference FROM payments WHERE order_id IN (2210,2211,2212) ORDER BY id`)
ok(pays.rows.length === 2, `cloud payments: ${pays.rows.length}/2`)
const neg = pays.rows.find((p: any) => p.amount < 0)
ok(!!neg && /mazaj-revoke/.test(neg.reference), 'cloud negative payment landed (−182.70 mazaj-revoke)')
const audits = await pool.query(`SELECT COUNT(*) FROM audit_logs WHERE entity='order' AND entity_id IN (2210,2211,2212)`)
ok(Number(audits.rows[0].count) >= 6, `cloud probe audit rows: ${audits.rows[0].count} (webhook×3 + revoke×3)`)
const t21 = await pool.query(`SELECT status FROM tables WHERE id=21`)
ok(t21.rows[0].status === 'free', 'cloud table 21 free')
const revAudit = await pool.query(`SELECT details FROM audit_logs WHERE action='integration.mazajRevoke' AND entity_id=2212`)
ok(/Amira/.test(revAudit.rows[0]?.details ?? ''), 'cloud revoke audit names Amira (staff PIN authorizer)')

await pool.end()
console.log(failed === 0 ? '\nDESKTOP → CLOUD (UP) VERIFIED — the engine pushed the whole E2E chain to Neon' : `\n${failed} FAILURE(S)`)
process.exit(failed === 0 ? 0 : 1)
