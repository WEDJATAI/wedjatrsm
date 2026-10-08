import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'
const rp = new PrismaClient({ adapter: new PrismaLibSql({ url: ('file:/home/z/my-project/download/rsm-platform-database.db').split('?')[0] }), log: ['error'] }) /* r49 */
const c4 = await rp.customer.findUnique({ where: { id: 4 } })
console.log('RECOVERY-POINT customer #4 (original):', c4 ? JSON.stringify({ id: c4.id, name: c4.name, phone: c4.phone, visits: c4.visits, points: c4.points, totalSpent: c4.totalSpent, notes: c4.notes }) : 'MISSING')
await rp.$disconnect()
