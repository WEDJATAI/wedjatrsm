// r70 audit: full Order + Payment parity scan local (SQLite) vs Neon (cloud)
import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import { Pool } from "pg"
import { neonPooledUrl } from "../lib/env-local"

const db = new PrismaClient({ adapter: new PrismaLibSql({ url: (process.env.DATABASE_URL ?? 'file:./db/custom.db').split('?')[0] }) })
const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false } })

// LOCAL orders
const lOrders = new Map((await db.order.findMany({ select: { id: true, status: true, totalAmount: true, userId: true, closedAt: true } })).map(o => [o.id, o]))
const lPays = new Map((await db.payment.findMany({ select: { id: true, orderId: true, amount: true, tip: true, method: true } })).map(p => [p.id, p]))
await db.$disconnect()

const nOrders = new Map((await pool.query("SELECT id, status, total_amount, user_id, closed_at FROM orders")).rows.map((r: any) => [r.id, r]))
const nPays = new Map((await pool.query("SELECT id, order_id, amount, tip, method FROM payments")).rows.map((r: any) => [r.id, r]))
await pool.end()

const near = (a: number | null | undefined, b: number | null | undefined) => Math.abs((a ?? 0) - (b ?? 0)) < 0.005
const dOrder: string[] = []
for (const [id, n] of nOrders) {
  const l = lOrders.get(id)
  if (!l) { dOrder.push(`#${id}: missing locally (cloud status ${n.status})`); continue }
  if (l.status !== n.status) dOrder.push(`#${id}: status local=${l.status} cloud=${n.status}`)
  if (!near(l.totalAmount, n.total_amount)) dOrder.push(`#${id}: total local=${l.totalAmount} cloud=${n.total_amount}`)
  if ((l.userId ?? null) !== (n.user_id ?? null)) dOrder.push(`#${id}: userId local=${l.userId} cloud=${n.user_id}`)
}
for (const [id] of lOrders) if (!nOrders.has(id)) dOrder.push(`#${id}: exists locally, missing on cloud`)

const dPay: string[] = []
for (const [id, n] of nPays) {
  const l = lPays.get(id)
  if (!l) { dPay.push(`#${id}: missing locally (cloud orderId ${n.order_id} amount ${n.amount})`); continue }
  if (l.orderId !== n.order_id) dPay.push(`#${id}: orderId local=${l.orderId} cloud=${n.order_id} (amount ${l.amount})`)
  if (!near(l.amount, n.amount)) dPay.push(`#${id}: amount local=${l.amount} cloud=${n.amount}`)
  if (!near(l.tip ?? 0, n.tip ?? 0)) dPay.push(`#${id}: tip local=${l.tip} cloud=${n.tip}`)
}
for (const [id] of lPays) if (!nPays.has(id)) dPay.push(`#${id}: exists locally, missing on cloud`)

console.log(`ORDER_DIVERGENCES (${dOrder.length}):`)
for (const d of dOrder) console.log('  ' + d)
console.log(`PAYMENT_DIVERGENCES (${dPay.length}):`)
for (const d of dPay) console.log('  ' + d)
