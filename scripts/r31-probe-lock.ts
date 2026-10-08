import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'
const probe = new PrismaClient({ adapter: new PrismaLibSql({ url: ('file:/home/z/my-project/db/custom.db?socket_timeout=4000').split('?')[0] }) }) /* r49 */
const t0 = Date.now()
try {
  await probe.$queryRawUnsafe('PRAGMA busy_timeout=3000')
  await probe.order.update({ where: { id: 1 }, data: { updatedAt: new Date() } })
  console.log(`probe: write lock FREE (took ${Date.now() - t0}ms)`)
} catch (e) {
  console.log(`probe: write lock HELD (failed after ${Date.now() - t0}ms): ${(e as Error).message.slice(0, 90)}`)
} finally { await probe.$disconnect() }
