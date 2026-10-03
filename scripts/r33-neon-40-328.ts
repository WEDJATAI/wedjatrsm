import { Pool } from 'pg'
import { neonPooledUrl } from './lib/env-local'
async function main() {
  const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
  const r = await pool.query(`SELECT id, status, total_amount, updated_at, closed_at, origin_device_id FROM orders WHERE id IN (40, 328)`)
  for (const x of r.rows) console.log('neon', JSON.stringify(x))
  // neon open orders list
  const op = await pool.query(`SELECT id FROM orders WHERE status='open' ORDER BY id`)
  console.log('neon open ids:', op.rows.map((x: any) => x.id).join(','))
  await pool.end()
}
main().then(() => process.exit(0)).catch(e => { console.error('ERR', e.message); process.exit(1) })
