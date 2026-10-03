import { Pool } from 'pg'
import { neonPooledUrl } from './lib/env-local'
async function main() {
  const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
  const r = await pool.query(`SELECT id, order_id, product_id FROM order_items WHERE id >= 1495 ORDER BY id`)
  console.log('NEON items >= 1495:')
  for (const x of r.rows) console.log('  ', x.id, '→ order', x.order_id, 'product', x.product_id)
  await pool.end()
}
main().then(() => process.exit(0)).catch(e => { console.error('ERR', e.message); process.exit(1) })
