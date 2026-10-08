import { Pool } from 'pg'
import { neonPooledUrl } from './lib/env-local'
async function main() {
  const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
  const p = await pool.query(`SELECT id, order_id, amount, method, reference FROM payments WHERE id >= 214 ORDER BY id`)
  console.log('Neon payments >= 214:')
  for (const r of p.rows) console.log('  ', r.id, 'order', r.order_id, r.amount, String(r.reference).slice(0, 50))
  const mx = await pool.query(`SELECT MAX(id) m FROM payments`)
  console.log('Neon max payment id:', mx.rows[0].m)
  const oi = await pool.query(`SELECT id, order_id, product_id FROM order_items WHERE order_id = 1216`)
  console.log('Neon order_items for 1216:', oi.rows.map((x: any) => `${x.id}(o${x.order_id},p${x.product_id})`).join(', '))
  const omi = await pool.query(`SELECT MAX(id) m FROM order_items`)
  console.log('Neon max order_item id:', omi.rows[0].m)
  await pool.end()
}
main().then(() => process.exit(0)).catch(e => { console.error('ERR', e.message); process.exit(1) })
