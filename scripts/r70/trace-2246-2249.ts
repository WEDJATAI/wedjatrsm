import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import { Pool } from "pg"
import { neonPooledUrl } from "../lib/env-local"
const db = new PrismaClient({ adapter: new PrismaLibSql({ url: (process.env.DATABASE_URL ?? 'file:./db/custom.db').split('?')[0] }) })

for (const id of [2246, 2249]) {
  const o = await db.order.findUnique({ where: { id }, include: { payments: { select: { id: true, amount: true, method: true } } } })
  console.log(`LOCAL_ORDER_${id}:`, JSON.stringify({ status: o?.status, total: o?.totalAmount, closedAt: o?.closedAt, pays: o?.payments.map(p => `${p.id}:${p.amount}`) }))
}
await db.$disconnect()

const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false } })
for (const id of [2246, 2249]) {
  const o = (await pool.query("SELECT id, status, total_amount, closed_at FROM orders WHERE id = $1", [id])).rows
  const p = (await pool.query("SELECT id, amount FROM payments WHERE order_id = $1 ORDER BY id", [id])).rows
  console.log(`NEON_ORDER_${id}:`, JSON.stringify({ row: o, pays: p.map((r: any) => `${r.id}:${r.amount}`) }))
}
const evts = (await pool.query('SELECT id, "entityId", operation, status, direction, "deviceId", "createdAt" FROM hybrid_events WHERE entity = $1 AND "entityId" = ANY($2) ORDER BY id', ["Order", ["2246", "2249"]])).rows
console.log("NEON_2246_2249_EVENTS:", JSON.stringify(evts.map((e: any) => ({ id: e.id, eid: e.entityId, op: e.operation, st: e.status, dir: e.direction, at: e.createdAt }))))
await pool.end()
