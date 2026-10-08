import { Pool } from 'pg'
import { neonPooledUrl } from './lib/env-local'
import { Database } from 'bun:sqlite'
const EPS = 0.02
async function main() {
  const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
  const neon = await pool.query(`
    SELECT o.id, o.total_amount, COALESCE(SUM(p.amount), 0) pay_sum
    FROM orders o LEFT JOIN payments p ON p.order_id = o.id
    WHERE o.status IN ('paid','revoked') AND o.id >= 200
    GROUP BY o.id, o.total_amount ORDER BY o.id`)
  await pool.end()
  const db = new Database('/home/z/my-project/db/custom.db', { readonly: true })
  const local = db.prepare(`
    SELECT o.id, o.total_amount, COALESCE(SUM(p.amount), 0) pay_sum
    FROM orders o LEFT JOIN payments p ON p.order_id = o.id
    WHERE o.status IN ('paid','revoked') AND o.id >= 200
    GROUP BY o.id, o.total_amount ORDER BY o.id`).all() as any[]
  console.log('LOCAL recent-era (id>=200) mismatches:')
  for (const r of local) if (Math.abs(r.total_amount - r.pay_sum) > EPS) console.log(`  order ${r.id}: total=${r.total_amount} paysum=${Number(r.pay_sum).toFixed(2)}`)
  console.log('NEON recent-era (id>=200) mismatches:')
  for (const r of neon.rows) if (Math.abs(r.total_amount - r.pay_sum) > EPS) console.log(`  order ${r.id}: total=${r.total_amount} paysum=${Number(r.pay_sum).toFixed(2)}`)
}
main().then(() => process.exit(0)).catch(e => { console.error('ERR', e.message); process.exit(1) })
