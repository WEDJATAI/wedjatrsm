import { PrismaClient as PgClient } from '../../pgtmp-client'
import { neonPooledUrl } from '../lib/env-local'
async function main() {
  const pg = new PgClient({ datasources: { db: { url: neonPooledUrl() } } })
  try {
    const c = await pg.$queryRawUnsafe(`SELECT id, name, phone FROM customers WHERE id = 15`) as any[]
    console.log('NEON customer 15:', JSON.stringify(c))
    const ev = await pg.$queryRawUnsafe(`SELECT "eventId", entity, "entityId", operation, revision, status, direction, left("deviceId",8) dev FROM hybrid_events WHERE entity='Customer' AND "entityId"=15 ORDER BY id DESC LIMIT 3`) as any[]
    console.log('NEON Customer-15 events:', JSON.stringify(ev, null, 1))
  } finally { await pg.$disconnect() }
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1) })
