import { Pool } from 'pg'
import { neonPooledUrl } from '../lib/env-local'
import { db } from '../../src/lib/db'
const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
const safe = async (label: string, fn: () => Promise<void>) => {
  try { await fn() } catch (e) { console.log(`${label}: ERROR — ${(e as Error).message.slice(0, 90)}`) }
}

await safe('inventory columns', async () => {
  const cols = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='inventory_transactions' ORDER BY ordinal_position")
  console.log('inventory_transactions columns:', cols.rows.map((r: { column_name: string }) => r.column_name).join(','))
})

await safe('payments', async () => {
  const localPayIds = (await db.payment.findMany({ select: { id: true }, orderBy: { id: 'asc' } })).map((p) => p.id)
  const neonPay = await pool.query('SELECT id FROM payments ORDER BY id')
  const neonPayIds = neonPay.rows.map((r: { id: number }) => r.id)
  const missingOnNeon = localPayIds.filter((id) => !neonPayIds.includes(id))
  const missingOnLocal = neonPayIds.filter((id: number) => !localPayIds.includes(id))
  console.log(`payments: local=${localPayIds.length} neon=${neonPayIds.length}`)
  console.log('  missing on NEON (' + missingOnNeon.length + '):', missingOnNeon.slice(0, 60).join(','))
  console.log('  missing on LOCAL (' + missingOnLocal.length + '):', missingOnLocal.join(','))
  const sample = await db.payment.findMany({ where: { id: { in: missingOnNeon.slice(0, 2) } }, select: { id: true, orderId: true, amount: true, method: true, createdAt: true } }) // r49: Payment.status retired
  console.log('  sample local-only:', JSON.stringify(sample))
})

await safe('order_items', async () => {
  const localItemIds = (await db.orderItem.findMany({ select: { id: true } })).map((i) => i.id)
  const neonItems = await pool.query('SELECT id FROM order_items ORDER BY id')
  const neonItemIds = neonItems.rows.map((r: { id: number }) => r.id)
  console.log('order_items missing on NEON:', localItemIds.filter((id) => !neonItemIds.includes(id)).join(','))
  console.log('order_items missing on LOCAL:', neonItemIds.filter((id: number) => !localItemIds.includes(id)).join(','))
})

await safe('inventory_transactions', async () => {
  const localIds = (await db.inventoryTransaction.findMany({ select: { id: true } })).map((i) => i.id)
  const neon = await pool.query('SELECT id FROM inventory_transactions ORDER BY id')
  const neonIds = neon.rows.map((r: { id: number }) => r.id)
  console.log('inventory_tx missing on NEON:', localIds.filter((id) => !neonIds.includes(id)).join(','))
  console.log('inventory_tx missing on LOCAL:', neonIds.filter((id: number) => !localIds.includes(id)).join(','))
})

await safe('stock_counts', async () => {
  const localSC = await db.stockCount.findMany({ select: { id: true, method: true } as never })
  console.log('LOCAL stock_counts:', JSON.stringify(localSC))
})

await safe('customers', async () => {
  const localIds = (await db.customer.findMany({ select: { id: true } })).map((c) => c.id)
  const neon = await pool.query('SELECT id FROM customers ORDER BY id')
  const neonIds = neon.rows.map((r: { id: number }) => r.id)
  console.log('customers missing on NEON:', localIds.filter((id) => !neonIds.includes(id)).join(','))
  console.log('customers missing on LOCAL:', neonIds.filter((id: number) => !localIds.includes(id)).join(','))
})

await pool.end()
await db.$disconnect()
