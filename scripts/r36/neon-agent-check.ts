// r36: verify the agent-pushed customer rename landed on Neon (the hub's
// datastore) — same pattern as scripts/r35/neon-agent-check.ts.
import { PrismaClient as PgClient } from '../../pgtmp-client'
import { PrismaPg } from '@prisma/adapter-pg'
import { neonPooledUrl } from '../lib/env-local'

async function main() {
  const pg = new PgClient({ adapter: new PrismaPg({ connectionString: neonPooledUrl() }) }) // r49: Prisma 7 adapter
  try {
    const c = (await pg.$queryRawUnsafe(`SELECT id, name, phone FROM customers WHERE id = 16`)) as any[]
    console.log('NEON customer 16:', JSON.stringify(c))
    const ev = (await pg.$queryRawUnsafe(
      `SELECT "eventId", entity, "entityId", operation, revision, status, direction, left("deviceId",8) AS dev
       FROM hybrid_events WHERE entity='Customer' AND "entityId"=16 ORDER BY id DESC LIMIT 5`,
    )) as any[]
    console.log('NEON Customer/16 events:', JSON.stringify(ev, null, 1))
    const d = (await pg.$queryRawUnsafe(
      `SELECT id, left("deviceId",8) AS dev, name, platform, active FROM hybrid_devices ORDER BY "createdAt" DESC LIMIT 8`,
    )) as any[]
    console.log('NEON recent devices:', JSON.stringify(d, null, 1))
  } finally {
    await pg.$disconnect()
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(e.message)
  process.exit(1)
})
