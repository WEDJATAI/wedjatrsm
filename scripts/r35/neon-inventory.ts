import { PrismaClient as PgClient } from '../../pgtmp-client'
import { PrismaPg } from '@prisma/adapter-pg'
import { neonPooledUrl } from '../lib/env-local'
async function main() {
  const pg = new PgClient({ adapter: new PrismaPg({ connectionString: neonPooledUrl() }) }) // r49: Prisma 7 adapter
  try {
    console.log('=== NEON devices ===')
    const d = await pg.$queryRawUnsafe(`SELECT id, "deviceId", name, platform, status FROM hybrid_devices ORDER BY id`) as any[]
    for (const r of d) console.log([r.id, r.deviceId.slice(0,8), r.name, r.platform, r.status].join(' | '))
    console.log('=== NEON Customer-15 events ===')
    const ev = await pg.$queryRawUnsafe(`SELECT id, direction, operation, revision, status FROM hybrid_events WHERE entity='Customer' AND "entityId"=15 ORDER BY id`) as any[]
    for (const r of ev) console.log([r.id, r.direction, r.operation, 'rev'+r.revision, r.status].join(' | '))
  } finally { await pg.$disconnect() }
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1) })
