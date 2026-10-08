import { Pool } from 'pg'
import { neonPooledUrl } from '../lib/env-local'
import { db } from '../../src/lib/db'
const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })

const it = await pool.query('SELECT id, product_id, quantity_change, reason, order_id, created_at FROM inventory_transactions WHERE id >= 467 ORDER BY id')
console.log('NEON-only inventory_tx 467+:', JSON.stringify(it.rows, null, 1))

const pays = await db.payment.findMany({ where: { id: { in: [220, 221, 240, 264] } }, select: { id: true, orderId: true, amount: true, method: true, createdAt: true, tip: true } })
console.log('LOCAL payments 220-264 sample:', JSON.stringify(pays, null, 1))

// which orders do payments 220-264 belong to + their sync state on Neon
const allMissing = (await db.payment.findMany({ where: { id: { gte: 220 } }, select: { orderId: true } })).map((p) => p.orderId)
const ord = await db.order.findMany({ where: { id: { in: [...new Set(allMissing)].slice(0, 8) } }, select: { id: true, status: true, createdAt: true } })
console.log('their orders sample:', JSON.stringify(ord))

// FK check: any Neon products referencing category 29?
const ref29 = await pool.query('SELECT count(*)::int c FROM products WHERE category_id = 29')
console.log('Neon products referencing category 29:', ref29.rows[0].c)

// hybrid_events for payments 220+ on Neon (were events ever pushed?)
const hev = await pool.query("SELECT entity, \"entityId\", operation, status, direction FROM hybrid_events WHERE entity='Payment' AND \"entityId\" >= 220 ORDER BY id LIMIT 5")
console.log('Neon hybrid_events Payment>=220:', JSON.stringify(hev.rows))

// local outbox events for payment 220-264 — emitted at all?
const lev = await db.hybridEvent.findMany({ where: { entity: 'Payment', entityId: { gte: 220 } }, select: { entityId: true, status: true, direction: true }, take: 5 })
console.log('LOCAL outbox Payment>=220:', JSON.stringify(lev))

await pool.end()
await db.$disconnect()
