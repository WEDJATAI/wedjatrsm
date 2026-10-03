import { PrismaClient as PgClient } from '../pgtmp-client'
import { neonPooledUrl } from './lib/env-local'
async function main() {
  const pg = new PgClient({ datasources: { db: { url: neonPooledUrl() } } })
  try {
    const rows = await pg.$queryRawUnsafe(`SELECT it.id, it.product_id, p.name, it.quantity_change, it.reason, it.created_at FROM inventory_transactions it JOIN products p ON p.id = it.product_id WHERE it.created_at > '2026-10-03T08:00' ORDER BY it.id DESC LIMIT 30`) as any[]
    console.log(`Neon inventory transactions after 08:00 (${rows.length}):`)
    rows.forEach((r: any) => console.log(' ', r.id, r.name, r.quantity_change, r.reason, String(r.created_at).slice(11, 19)))
    const upd = await pg.$queryRawUnsafe(`SELECT id, name, stock, updated_at FROM products WHERE id IN (1, 9, 12, 14, 232) ORDER BY id`) as any[]
    console.log('current rows + updated_at:')
    upd.forEach((u: any) => console.log(' ', u.id, u.name, u.stock, String(u.updated_at).slice(11, 19)))
  } finally { await pg.$disconnect() }
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1) })
