import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'

async function main() {
const db = new PrismaClient({ adapter: new PrismaLibSql({ url: (process.env.DATABASE_URL ?? 'file:./db/custom.db').split('?')[0] }) })
const o = await db.order.findUnique({ where: { id: 2246 }, include: { payments: true } })
console.log('ORDER 2246:', JSON.stringify({
  status: o?.status, total: o?.totalAmount, subtotal: o?.subtotalAmount, createdAt: o?.createdAt, closedAt: o?.closedAt,
  payments: o?.payments.map(p => ({ id: p.id, method: p.method, amount: p.amount, tip: p.tip, ref: p.reference })),
}))
// Re-run coverage with refunds counted (net payments)
const coverage = (await db.$queryRawUnsafe(
  `SELECT o.id, o.total_amount, COALESCE(SUM(p.amount), 0) AS netPaid
   FROM orders o LEFT JOIN payments p ON p.order_id = o.id
   WHERE o.status = 'paid'
   GROUP BY o.id
   HAVING ABS(o.total_amount - netPaid) > 0.005`
)) as Array<{ id: number; total_amount: number; netPaid: number }>
console.log('PAID_BUT_NET_UNDERCOVERED:', JSON.stringify(coverage))
// Money precision, refined: >2 significant decimals only
const badMoney = (await db.$queryRawUnsafe(
  `SELECT id, amount FROM payments WHERE ABS(amount * 100 - ROUND(amount * 100)) > 0.001 LIMIT 5`
)) as Array<{ id: number; amount: number }>
console.log('TRUE_BAD_MONEY:', JSON.stringify(badMoney))
await db.$disconnect()

}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
