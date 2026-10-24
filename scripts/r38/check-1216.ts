import { Pool } from 'pg'
import { neonPooledUrl } from '../lib/env-local'
import { db } from '../../src/lib/db'
const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })

const o = await db.order.findUnique({ where: { id: 1216 }, select: { id: true, status: true, closedAt: true } })
console.log('LOCAL order 1216:', JSON.stringify(o))
const n = await pool.query('SELECT id, status FROM orders WHERE id = 1216')
console.log('NEON order 1216:', JSON.stringify(n.rows))

const lp = await db.product.findMany({ where: { id: { in: [6, 9, 296] } }, select: { id: true, name: true, stock: true } })
console.log('LOCAL products 6/9/296:', JSON.stringify(lp))
const np = await pool.query('SELECT id, name, stock FROM products WHERE id IN (6,9,296)')
console.log('NEON products 6/9/296:', JSON.stringify(np.rows))

// local inventory txns for order 1216?
const lit = await db.inventoryTransaction.findMany({ where: { orderId: 1216 }, select: { id: true, productId: true, quantityChange: true } })
console.log('LOCAL inventory_tx for order 1216:', JSON.stringify(lit))

await pool.end()
await db.$disconnect()
