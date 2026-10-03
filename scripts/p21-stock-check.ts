import { db } from '../src/lib/db'
import { PrismaClient as PgClient } from '../pgtmp-client'
import { neonPooledUrl } from './lib/env-local'
async function main() {
  const local = await db.$queryRaw<any[]>`SELECT id, name, stock FROM products WHERE id IN (9, 232, 12, 1, 14) ORDER BY id`
  console.log('LOCAL stocks:')
  local.forEach((p: any) => console.log(' ', p.id, p.name, p.stock))
  const pg = new PgClient({ datasources: { db: { url: neonPooledUrl() } } })
  try {
    const neon = await pg.$queryRawUnsafe(`SELECT id, name, stock FROM products WHERE id IN (9, 232, 12, 1, 14) ORDER BY id`) as any[]
    console.log('NEON stocks:')
    neon.forEach((p: any) => console.log(' ', p.id, p.name, p.stock))
    // Neon cheese transactions today
    const tx = await pg.$queryRawUnsafe(`SELECT it.quantity_change, it.reason, it.created_at, o.id oid FROM inventory_transactions it LEFT JOIN orders o ON o.id = it.order_id WHERE it.product_id = 9 AND it.created_at > '2026-10-03' ORDER BY it.id DESC LIMIT 15`) as any[]
    console.log('NEON cheese transactions today:')
    tx.forEach((t: any) => console.log(' ', t.quantity_change, t.reason, String(t.created_at).slice(11, 19), t.oid ? 'order ' + t.oid : ''))
  } finally { await pg.$disconnect() }
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1) })
