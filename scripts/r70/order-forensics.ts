// r70 audit: forensics on under-covered paid orders
import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'
const db = new PrismaClient({ adapter: new PrismaLibSql({ url: (process.env.DATABASE_URL ?? 'file:./db/custom.db').split('?')[0] }) })

for (const id of [2221, 2246]) {
  const o = await db.order.findUnique({ where: { id }, include: { payments: true, user: { select: { id: true, name: true } } } })
  if (!o) { console.log(`ORDER ${id}: NOT FOUND`); continue }
  console.log(`ORDER ${id}:`, JSON.stringify({
    status: o.status, orderType: o.orderType, total: o.totalAmount, subtotal: o.subtotalAmount,
    discount: o.discountAmount, userId: o.userId, userName: o.user?.name,
    createdAt: o.createdAt, closedAt: o.closedAt, externalRef: o.externalRef,
    payments: o.payments.map(p => ({ id: p.id, method: p.method, amount: p.amount, tip: p.tip, ref: p.reference })),
  }))
  // audit trail for this order
  const logs = await db.auditLog.findMany({
    where: { OR: [{ entity: `order:${id}` }, { entity: 'order', entityId: String(id) }, { details: { contains: `#${id}` } }] },
    orderBy: { id: 'asc' }, select: { id: true, action: true, details: true, createdAt: true, userName: true },
  })
  console.log(`  AUDIT (${logs.length}):`, JSON.stringify(logs.slice(0, 12)))
}
await db.$disconnect()
