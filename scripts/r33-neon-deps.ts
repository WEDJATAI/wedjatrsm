import { Pool } from 'pg'
import { neonPooledUrl } from './lib/env-local'
async function main() {
  const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
  const t = await pool.query(`SELECT id FROM tables WHERE id IN (1)`)
  console.log('Neon table id=1:', t.rows.length ? 'EXISTS' : 'MISSING')
  const p = await pool.query(`SELECT id, name FROM persons ORDER BY id`)
  console.log('Neon persons:', p.rows.map((x: any) => `${x.id}:${x.name}`).join(' '))
  const pr = await pool.query(`SELECT id FROM products WHERE id IN (54, 111, 71)`)
  console.log('Neon products 54/111/71:', pr.rows.map((x: any) => x.id).join(',') || 'MISSING SOME')
  const u = await pool.query(`SELECT id, name FROM users WHERE id = 4`)
  console.log('Neon user 4:', u.rows.length ? u.rows[0].name : 'MISSING')
  // payments 216,217?
  const pay = await pool.query(`SELECT id, order_id, amount FROM payments WHERE id IN (216,217)`)
  console.log('Neon payments 216/217:', pay.rows.map((x: any) => `${x.id}/o${x.order_id}/${x.amount}`).join(' ') || 'MISSING')
  const items = await pool.query(`SELECT id FROM order_items WHERE id IN (1505,1509,1510,1511)`)
  console.log('Neon order_items 1505/1509/1510/1511:', items.rows.map((x: any) => x.id).join(',') || 'MISSING')
  // local-only product ids vs neon
  await pool.end()
  const { Database } = await import('bun:sqlite')
  const db = new Database('/home/z/my-project/db/custom.db', { readonly: true })
  const localIds = new Set((db.prepare('SELECT id FROM products').all() as any[]).map(r => r.id))
  console.log('local products:', localIds.size)
}
main().then(() => process.exit(0)).catch(e => { console.error('ERR', e.message); process.exit(1) })
