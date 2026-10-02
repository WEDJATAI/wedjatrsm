// Round 15 safety backup — consistent WAL-safe snapshot before any change
import { PrismaClient } from '@prisma/client'
const db = new PrismaClient()
const name = `custom-round15-start-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}.db`
async function main() {
  await db.$executeRawUnsafe(`VACUUM INTO 'backups/${name}'`)
  console.log('backup ok:', name)
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
