// r70 audit: local SQLite integrity + FK + money precision + coverage
import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'
const db = new PrismaClient({ adapter: new PrismaLibSql({ url: (process.env.DATABASE_URL ?? 'file:./db/custom.db').split('?')[0] }) })

const integrity = (await db.$queryRawUnsafe(`PRAGMA integrity_check`)) as Array<{ integrity_check: string }>
console.log('INTEGRITY:', JSON.stringify(integrity))
const fk = (await db.$queryRawUnsafe(`PRAGMA foreign_key_check`)) as unknown[]
console.log('FK_VIOLATIONS:', fk.length)

const orders = await db.order.count()
const paid = await db.order.count({ where: { status: 'paid' } })
const open = await db.order.count({ where: { status: 'open' } })
const payments = await db.payment.count()
console.log('COUNTS:', JSON.stringify({ orders, paid, open, payments }))

const badTotals = (await db.$queryRawUnsafe(
  `SELECT id, total_amount FROM orders WHERE CAST(total_amount * 100 AS INTEGER) != total_amount * 100 LIMIT 5`,
)) as Array<{ id: number; total_amount: number }>
console.log('BAD_ORDER_TOTALS:', JSON.stringify(badTotals))

const badAmounts = (await db.$queryRawUnsafe(
  `SELECT id, amount FROM payments WHERE CAST(amount * 100 AS INTEGER) != amount * 100 LIMIT 5`,
)) as Array<{ id: number; amount: number }>
console.log('BAD_PAYMENT_AMOUNTS:', JSON.stringify(badAmounts))

const coverage = (await db.$queryRawUnsafe(
  `SELECT o.id, o.total_amount, COALESCE(SUM(p.amount), 0) AS paidSum
   FROM orders o LEFT JOIN payments p ON p.order_id = o.id
   WHERE o.status = 'paid'
   GROUP BY o.id
   HAVING ABS(o.total_amount - paidSum) > 0.005
   LIMIT 8`,
)) as Array<{ id: number; total_amount: number; paidSum: number }>
console.log('PAID_BUT_UNDERCOVERED:', JSON.stringify(coverage))

const orphanPays = (await db.$queryRawUnsafe(
  `SELECT COUNT(*) AS n FROM payments WHERE order_id NOT IN (SELECT id FROM orders)`,
)) as Array<{ n: number }>
console.log('ORPHAN_PAYMENTS:', JSON.stringify(orphanPays))

const noClosed = await db.order.count({ where: { status: 'paid', closedAt: null } })
console.log('PAID_MISSING_CLOSEDAT:', noClosed)

const users = await db.user.count()
const products = await db.product.count()
console.log('REFERENCE_COUNTS:', JSON.stringify({ users, products }))

await db.$disconnect()
