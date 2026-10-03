import { PrismaClient as PgClient } from '../pgtmp-client'
import { neonPooledUrl } from './lib/env-local'
async function main() {
  const pg = new PgClient({ datasources: { db: { url: neonPooledUrl() } } })
  try {
    const rows = await pg.$queryRawUnsafe(`SELECT "eventId", "entityId", status, "createdAt", json_extract_path_text(payload::json, 'stock') as stock FROM hybrid_events WHERE entity='Product' AND "entityId" IN (1, 9, 12) AND "createdAt" > '2026-10-03T07:00' ORDER BY id DESC LIMIT 25`) as any[]
    rows.forEach((r: any) => console.log(String(r.createdAt).slice(11, 19), 'Product#' + r.entityId, r.status, 'stock=' + r.stock, r.eventId?.slice(0, 8)))
  } finally { await pg.$disconnect() }
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1) })
