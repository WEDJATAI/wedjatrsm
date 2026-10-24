import { Pool } from 'pg'
import { neonPooledUrl } from '../lib/env-local'
const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
const o2 = await pool.query('SELECT id FROM orders WHERE customer_id = 2')
const o3 = await pool.query('SELECT id FROM orders WHERE customer_id = 3')
console.log('Neon orders referencing customer 2:', JSON.stringify(o2.rows), ' customer 3:', JSON.stringify(o3.rows))
const r2 = await pool.query('SELECT id FROM reservations WHERE customer_id IN (2,3)')
console.log('Neon reservations referencing 2/3:', JSON.stringify(r2.rows))
const l2 = await pool.query("SELECT id FROM loyalty_events WHERE customer_id IN (2,3)").catch(() => ({ rows: [] as unknown[] }))
console.log('loyalty_events referencing 2/3:', JSON.stringify(l2.rows))
// full stock divergence scan
const stockDiv = await pool.query('SELECT id FROM products ORDER BY id')
console.log('Neon product count:', stockDiv.rows.length)
await pool.end()
