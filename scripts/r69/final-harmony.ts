/** r69: final harmony check — hybrid outbox, Neon RW, prod manifest. */
import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'
const db = new PrismaClient({ adapter: new PrismaLibSql({ url: (process.env.DATABASE_URL ?? 'file:./db/custom.db').split('?')[0] }) })
async function main() {
  const pending = await db.hybridEvent.count({ where: { status: 'pending' } })
  const dead = await db.hybridEvent.count({ where: { status: 'dead' } })
  const last = await db.hybridEvent.findFirst({ orderBy: { id: 'desc' }, select: { id: true, createdAt: true, direction: true, status: true, entity: true, entityId: true } })
  console.log('outbox: pending', pending, '· dead', dead)
  console.log('last event:', JSON.stringify(last))
}
main().catch(e => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
