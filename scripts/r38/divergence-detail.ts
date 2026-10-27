import { Pool } from 'pg'
import { neonPooledUrl } from '../lib/env-local'
import { db } from '../../src/lib/db'

const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })

// 1) local categories — is "Omelet" there?
const localCats = await db.category.findMany({ select: { id: true, name: true }, orderBy: { id: 'asc' } })
console.log('LOCAL categories:', localCats.map((c) => `${c.id}:${c.name}`).join(' '))

// 2) Neon inventory_transactions > localMax
const it = await pool.query("SELECT id, item_id, type, reason FROM inventory_transactions WHERE id > 466 ORDER BY id")
console.log('NEON inventory_tx > 466:', JSON.stringify(it.rows))

// 3) payments local vs neon id sets
const localPayIds = (await db.payment.findMany({ select: { id: true, orderId: true, createdAt: true }, orderBy: { id: 'asc' } })).map((p) => p.id)
const neonPay = await pool.query('SELECT id FROM payments ORDER BY id')
const neonPayIds = neonPay.rows.map((r: { id: number }) => r.id)
const missingOnNeon = localPayIds.filter((id) => !neonPayIds.includes(id))
const missingOnLocal = neonPayIds.filter((id: number) => !localPayIds.includes(id))
console.log('payments missing on NEON (' + missingOnNeon.length + '):', missingOnNeon.join(','))
console.log('payments missing on LOCAL (' + missingOnLocal.length + '):', missingOnLocal.join(','))
const sample = await db.payment.findMany({ where: { id: { in: missingOnNeon.slice(0, 3) } }, select: { id: true, orderId: true, amount: true, method: true, createdAt: true } })
console.log('sample local-only payments:', JSON.stringify(sample))

// 4) order_items missing on neon
const localItemIds = (await db.orderItem.findMany({ select: { id: true } }, )).map((i) => i.id)
const neonItems = await pool.query('SELECT id FROM order_items ORDER BY id')
const neonItemIds = neonItems.rows.map((r: { id: number }) => r.id)
const itemsMissing = localItemIds.filter((id) => !neonItemIds.includes(id))
console.log('order_items missing on NEON:', itemsMissing.join(','))

// 5) stock_counts local 2 vs neon 1
const localSC = await db.stockCount.findMany({ select: { id: true, status: true } })
console.log('LOCAL stock_counts:', JSON.stringify(localSC))

await pool.end()
await db.$disconnect()
