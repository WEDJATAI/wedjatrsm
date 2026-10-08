import { Pool } from 'pg'
import { neonPooledUrl } from '../lib/env-local'
const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
const t = await pool.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name")
console.log('NEON tables:', t.rows.map((r: { table_name: string }) => r.table_name).join(' '))
const cat = await pool.query('SELECT id, name FROM categories WHERE id > 28')
console.log('Neon categories > 28:', JSON.stringify(cat.rows))
const it = await pool.query('SELECT id, "inventoryItemId", type FROM inventory_transactions WHERE id > 466 ORDER BY id')
console.log('Neon inventory_transactions > 466:', JSON.stringify(it.rows))
const pays = await pool.query('SELECT id, order_id, amount, method FROM payments WHERE id > 219 ORDER BY id LIMIT 3')
console.log('Neon payments > 219 (sample):', JSON.stringify(pays.rows))
await pool.end()
