import { Pool } from 'pg'
import { neonPooledUrl } from './lib/env-local'
import { Database } from 'bun:sqlite'
const EPS = 0.02
async function main() {
  const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
  const neon = await pool.query(`
    SELECT o.id, o.status, o.total_amount, COALESCE(SUM(p.amount), 0) pay_sum
    FROM orders o LEFT JOIN payments p ON p.order_id = o.id
    WHERE o.status IN ('paid', 'revoked')
    GROUP BY o.id, o.status, o.total_amount ORDER BY o.id`)
  await pool.end()
  const db = new Database('/home/z/my-project/db/custom.db', { readonly: true })
  const local = db.prepare(`
    SELECT o.id, o.status, o.total_amount, COALESCE(SUM(p.amount), 0) pay_sum
    FROM orders o LEFT JOIN payments p ON p.order_id = o.id
    WHERE o.status IN ('paid', 'revoked')
    GROUP BY o.id, o.status, o.total_amount ORDER BY o.id`).all() as any[]
  const audit = (name: string, rows: any[]) => {
    let bad = 0, old = 0, oldBad = 0
    for (const r of rows) {
      const diff = Math.abs(Number(r.total_amount) - Number(r.pay_sum))
      if (diff > EPS) {
        bad++
        if (r.id < 200) { old++; oldBad++ }
      }
    }
    console.log(`${name}: paid/revoked=${rows.length} mismatched(order total != payment sum)=${bad} (of which September-era id<200: ${oldBad})`)
    return { bad, rows }
  }
  const L = audit('LOCAL', local)
  const N = audit('NEON ', neon.rows)
  // show first few mismatches each
  for (const [name, res] of [['LOCAL', L], ['NEON ', N]] as const) {
    const bad = res.rows.filter(r => Math.abs(Number(r.total_amount) - Number(r.pay_sum)) > EPS).slice(0, 8)
    for (const b of bad) console.log(`  ${name} mismatch: order ${b.id} total=${b.total_amount} paysum=${Number(b.pay_sum).toFixed(2)}`)
  }
}
main().then(() => process.exit(0)).catch(e => { console.error('ERR', e.message); process.exit(1) })
