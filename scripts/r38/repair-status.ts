import { Pool } from 'pg'
import { neonPooledUrl } from '../lib/env-local'
const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
for (const t of ['customers', 'payments', 'order_items', 'inventory_transactions', 'stock_counts', 'stock_count_lines', 'attendance', 'audit_logs', 'categories']) {
  const c = await pool.query(`SELECT COUNT(*)::int c, COALESCE(MAX(id),0)::int m FROM ${t}`)
  console.log(`${t}: n=${c.rows[0].c} max=${c.rows[0].m}`)
}
const c18 = await pool.query('SELECT id, name FROM customers WHERE id IN (18,19)')
console.log('re-ided:', JSON.stringify(c18.rows))
const nulls = await pool.query('SELECT id FROM orders WHERE customer_id IS NULL')
console.log('orders w/ NULL customer (pending FK restore):', JSON.stringify(nulls.rows))
await pool.end()
