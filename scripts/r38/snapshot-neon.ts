import { Pool } from 'pg'
import { writeFileSync } from 'node:fs'
import { neonPooledUrl } from '../lib/env-local'
const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
const snap: Record<string, unknown> = {}
snap.customers_2_3 = (await pool.query('SELECT * FROM customers WHERE id IN (2,3)')).rows
snap.orders_fk_23 = (await pool.query('SELECT id, customer_id FROM orders WHERE customer_id IN (2,3)')).rows
snap.category_29 = (await pool.query('SELECT * FROM categories WHERE id = 29')).rows
snap.inventory_467_469 = (await pool.query('SELECT * FROM inventory_transactions WHERE id >= 467')).rows
snap.products_69296 = (await pool.query('SELECT * FROM products WHERE id IN (6,9,296)')).rows
writeFileSync('backups/r38/pre-repair-neon.json', JSON.stringify(snap, null, 1))
console.log('neon snapshot ok:', Object.keys(snap).join(', '))
await pool.end()
