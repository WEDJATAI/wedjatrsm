import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'

async function main() {
const db = new PrismaClient({ adapter: new PrismaLibSql({ url: (process.env.DATABASE_URL ?? 'file:./db/custom.db').split('?')[0] }) })
// Order 2246 now fully covered?
const o2246 = await db.order.findUnique({ where: { id: 2246 }, include: { payments: { select: { amount: true } } } })
console.log('ORDER_2246_COVERAGE:', JSON.stringify({ total: o2246?.totalAmount, paidSum: o2246?.payments.reduce((s, p) => s + p.amount, 0) }))
// Net coverage: paid orders where |total - net payments| > 0.005 AND not fully refunded
const rows = (await db.$queryRawUnsafe(
  `SELECT o.id, o.total_amount, COALESCE(SUM(p.amount), 0) AS netPaid,
          CASE WHEN EXISTS (SELECT 1 FROM payments r WHERE r.order_id = o.id AND r.amount < 0) THEN 1 ELSE 0 END AS hasRefund
   FROM orders o LEFT JOIN payments p ON p.order_id = o.id
   WHERE o.status = 'paid' GROUP BY o.id
   HAVING ABS(o.total_amount - COALESCE(SUM(p.amount), 0)) > 0.005`
)) as Array<{ id: number; total_amount: number; netPaid: number; hasRefund: number }>
console.log('NET_UNDERCOVERED (excl. refunded):', JSON.stringify(rows.filter(r => !r.hasRefund)))
console.log('REFUNDED_ORDERS (net zero, correct):', JSON.stringify(rows.filter(r => r.hasRefund).map(r => r.id)))
await db.$disconnect()

}

main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
