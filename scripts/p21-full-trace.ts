import { PrismaClient as PgClient } from '../pgtmp-client'
import { neonPooledUrl } from './lib/env-local'
async function main() {
  const pg = new PgClient({ datasources: { db: { url: neonPooledUrl() } } })
  try {
    const rows = await pg.$queryRawUnsafe(`SELECT id, "eventId", "entityId", direction, status, "createdAt", json_extract_path_text(payload::json, 'stock') as stock FROM hybrid_events WHERE entity='Product' AND "entityId" = 1 AND "createdAt" > '2026-10-02' ORDER BY id ASC`) as any[]
    console.log(`ALL Product#1 (chicken) events since Oct 2: ${rows.length}`)
    rows.forEach((r: any) => console.log(' ', r.id, String(r.createdAt).slice(5, 19), r.direction, r.status, 'stock=' + r.stock, r.eventId?.slice(0, 6)))
    // also: current transactions for chicken today
    const tx = await pg.$queryRawUnsafe(`SELECT id, quantity_change, reason, created_at FROM inventory_transactions WHERE product_id = 1 AND created_at > '2026-10-03' ORDER BY id`) as any[]
    console.log(`chicken transactions today: ${tx.length}`)
    tx.forEach((t: any) => console.log(' ', t.id, t.quantity_change, t.reason, String(t.created_at).slice(11, 19)))
  } finally { await pg.$disconnect() }
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1) })
