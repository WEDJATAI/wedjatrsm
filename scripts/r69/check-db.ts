import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'
const db = new PrismaClient({ adapter: new PrismaLibSql({ url: (process.env.DATABASE_URL ?? 'file:./db/custom.db').split('?')[0] }) })
async function main() {
  const orders = await db.order.findMany({ where: { id: { in: [2235, 2243, 2248, 2249, 2251, 2263, 2264] } }, select: { id: true, status: true, totalAmount: true, userId: true, orderType: true, updatedAt: true } })
  console.log('ORDERS:', JSON.stringify(orders))
  const ev = await db.hybridEvent.count()
  const pend = await db.hybridEvent.count({ where: { status: "pending" } })
  console.log('hybridEvents total=', ev, 'pending(status=pending)=', pend)
  const last = await db.hybridEvent.findFirst({ orderBy: { id: 'desc' }, select: { id: true, createdAt: true, entity: true, entityId: true, deviceId: true, direction: true, status: true } })
  console.log('LAST EVENT:', JSON.stringify(last))
  const u13 = await db.user.findFirst({ where: { id: 13 }, select: { id: true, name: true, role: true } })
  console.log('USER 13:', JSON.stringify(u13))
  console.log('orderCount=', await db.order.count(), 'shiftCount=', await db.shift.count())
}
main().catch(e => { console.error('ERR', e.message); process.exit(1) }).finally(() => db.$disconnect())
