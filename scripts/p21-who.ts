import { PrismaClient as PgClient } from '../pgtmp-client'
import { neonPooledUrl } from './lib/env-local'
async function main() {
  const pg = new PgClient({ datasources: { db: { url: neonPooledUrl() } } })
  try {
    const rows = await pg.$queryRawUnsafe(`SELECT id, entity, "entityId", "deviceId", status, "createdAt", json_extract_path_text(payload::json, 'stock') as stock FROM hybrid_events WHERE direction='in' AND "createdAt" BETWEEN '2026-10-03T07:40' AND '2026-10-03T08:15' AND entity IN ('Product','InventoryTransaction','Payment','Order') ORDER BY id ASC LIMIT 40`) as any[]
    rows.forEach((r: any) => console.log(r.id, String(r.createdAt).slice(11, 19), r.entity + '#' + r.entityId, 'dev=' + String(r.deviceId).slice(0, 10), r.status, 'stock=' + (r.stock ?? '-')))
    const devices = await pg.$queryRawUnsafe(`SELECT "deviceId", name, platform, "lastPushAt" FROM hybrid_devices ORDER BY "lastPushAt" DESC NULLS LAST`) as any[]
    console.log('\ndevices:')
    devices.forEach((d: any) => console.log(' ', String(d.deviceId).slice(0, 10), d.name, d.platform, String(d.lastPushAt).slice(0, 19)))
  } finally { await pg.$disconnect() }
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1) })
