import { Pool } from 'pg'
import { neonPooledUrl } from './lib/env-local'
async function main() {
  const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
  const o = await pool.query(`SELECT id, status FROM orders WHERE id IN (40, 328, 1211, 1214, 1215, 1216) ORDER BY id`)
  console.log('Neon order states:', o.rows.map((x: any) => `${x.id}/${x.status}`).join(' '))
  const c = await pool.query(`SELECT COUNT(*)::int c FROM orders`)
  const p = await pool.query(`SELECT COUNT(*)::int c FROM payments`)
  const it = await pool.query(`SELECT id, order_id FROM order_items WHERE id IN (1505, 1509, 1510, 1511, 1512, 1513) ORDER BY id`)
  const pay = await pool.query(`SELECT id, order_id, amount FROM payments WHERE id IN (216, 217, 218, 219) ORDER BY id`)
  console.log('Neon totals: orders=' + c.rows[0].c + ' payments=' + p.rows[0].c)
  console.log('Neon items:', it.rows.map((x: any) => `${x.id}→o${x.order_id}`).join(' '))
  console.log('Neon payments 216-219:', pay.rows.map((x: any) => `${x.id}/o${x.order_id}/${x.amount}`).join(' '))
  await pool.end()
}
main().then(() => process.exit(0)).catch(e => { console.error('ERR', e.message); process.exit(1) })
