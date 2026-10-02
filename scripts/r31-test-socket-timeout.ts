import { PrismaClient } from '@prisma/client'
const db = new PrismaClient({ datasources: { db: { url: 'file:/home/z/my-project/db/custom.db?socket_timeout=30000' } } })
try {
  const c = await db.order.count()
  console.log('socket_timeout param ACCEPTED, orders:', c)
} catch (e) {
  console.log('REJECTED:', (e as Error).message.slice(0, 200))
} finally { await db.$disconnect() }
