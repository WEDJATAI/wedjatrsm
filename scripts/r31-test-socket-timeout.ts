import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'
const db = new PrismaClient({ adapter: new PrismaLibSql({ url: ('file:/home/z/my-project/db/custom.db?socket_timeout=30000').split('?')[0] }) }) /* r49 */
try {
  const c = await db.order.count()
  console.log('socket_timeout param ACCEPTED, orders:', c)
} catch (e) {
  console.log('REJECTED:', (e as Error).message.slice(0, 200))
} finally { await db.$disconnect() }
