// Round 15 safety backup — consistent WAL-safe snapshot before any change
import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'
const db = new PrismaClient({ adapter: new PrismaLibSql({ url: (process.env.DATABASE_URL ?? 'file:./db/custom.db').split('?')[0] }) }) // r49: Prisma 7 adapter
const name = `custom-round15-start-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}.db`
async function main() {
  await db.$executeRawUnsafe(`VACUUM INTO 'backups/${name}'`)
  console.log('backup ok:', name)
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
