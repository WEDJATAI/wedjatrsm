import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'
const rp = new PrismaClient({ adapter: new PrismaLibSql({ url: ('file:/home/z/my-project/download/rsm-platform-database.db').split('?')[0] }), log: ['error'] }) /* r49 */
const orig = await rp.customer.findUnique({ where: { id: 4 } })
await rp.$disconnect()
if (!orig) { console.error('original #4 missing in recovery point'); process.exit(1) }
console.log('original:', JSON.stringify({ visits: orig.visits, points: orig.points, totalSpent: orig.totalSpent, lastVisitAt: orig.lastVisitAt }))

const { db } = await import('../../src/lib/db')
const repaired = await db.customer.update({
  where: { id: 4 },
  data: { visits: orig.visits, totalSpent: orig.totalSpent, lastVisitAt: orig.lastVisitAt },
})
console.log('local repaired (visits/totalSpent/lastVisitAt):', JSON.stringify({ visits: repaired.visits, totalSpent: repaired.totalSpent, lastVisitAt: repaired.lastVisitAt }))
console.log('NEXT: points will be restored via the audited API pointsAdjust (+925)')
await db.$disconnect()
