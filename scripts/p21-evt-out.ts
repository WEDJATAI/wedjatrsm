import { PrismaClient as PgClient } from '../pgtmp-client'
import { neonPooledUrl } from './lib/env-local'
async function main() {
  const pg = new PgClient({ datasources: { db: { url: neonPooledUrl() } } })
  try {
    const rows = await pg.$queryRawUnsafe(`SELECT "eventId", "entityId", direction, status, "createdAt", json_extract_path_text(payload::json, 'stock') as stock FROM hybrid_events WHERE entity='Product' AND "entityId" = 9 AND direction='out' AND "createdAt" > '2026-10-03T07:00' ORDER BY id DESC LIMIT 20`) as any[]
    console.log('Neon OUT events for Product#9 (cheese) today:')
    rows.forEach((r: any) => console.log(' ', String(r.createdAt).slice(11, 19), r.direction, r.status, 'stock=' + r.stock, r.eventId?.slice(0, 8)))
    if (rows.length === 0) console.log('  (none)')
    // orders paid on prod after 08:00?
    const orders = await pg.$queryRawUnsafe(`SELECT id, status, total_amount, closed_at FROM orders WHERE closed_at > '2026-10-03T08:00' ORDER BY id DESC LIMIT 10`) as any[]
    console.log('Orders closed on Neon after 08:00:')
    orders.forEach((o: any) => console.log(' ', o.id, o.status, o.total_amount, String(o.closed_at).slice(11, 19)))
  } finally { await pg.$disconnect() }
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1) })
