import { PrismaClient as PgClient } from '../pgtmp-client'
import { neonPooledUrl } from './lib/env-local'
async function main() {
  const pg = new PgClient({ datasources: { db: { url: neonPooledUrl() } } })
  try {
    const rows = await pg.$queryRawUnsafe(`SELECT id, entity, "entityId", "deviceId", status, "createdAt" FROM hybrid_events WHERE direction='out' AND "createdAt" > '2026-10-03T07:00' ORDER BY id DESC LIMIT 40`) as any[]
    console.log(`Neon OUT (cloud-origin) events since 07:00: ${rows.length}`)
    rows.forEach((r: any) => console.log(' ', r.id, r.entity + '#' + r.entityId, 'dev=' + String(r.deviceId).slice(0, 8), r.status, String(r.createdAt).slice(11, 19)))
  } finally { await pg.$disconnect() }
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1) })
