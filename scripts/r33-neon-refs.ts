import { Pool } from 'pg'
import { neonPooledUrl } from './lib/env-local'
import { Database } from 'bun:sqlite'
async function main() {
  const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
  const u14 = await pool.query(`SELECT COUNT(*)::int c FROM orders WHERE user_id = 14`)
  const u4 = await pool.query(`SELECT COUNT(*)::int c FROM orders WHERE user_id = 4`)
  console.log('Neon orders user_id=14:', u14.rows[0].c, '| user_id=4:', u4.rows[0].c)
  const neonProducts = await pool.query('SELECT id FROM products ORDER BY id')
  await pool.end()
  const db = new Database('/home/z/my-project/db/custom.db', { readonly: true })
  const localIds = new Set((db.prepare('SELECT id FROM products').all() as any[]).map(r => r.id))
  const neonIds = new Set((neonProducts.rows as any[]).map(r => Number(r.id)))
  const onlyLocal = [...localIds].filter(id => !neonIds.has(id))
  const onlyNeon = [...neonIds].filter(id => !localIds.has(id))
  console.log('products only-local:', onlyLocal.join(',') || 'none', '| only-neon:', onlyNeon.join(',') || 'none')
}
main().then(() => process.exit(0)).catch(e => { console.error('ERR', e.message); process.exit(1) })
