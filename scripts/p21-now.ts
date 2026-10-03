import { PrismaClient as PgClient } from '../pgtmp-client'
import { neonPooledUrl } from './lib/env-local'
async function main() {
  const pg = new PgClient({ datasources: { db: { url: neonPooledUrl() } } })
  try {
    const upd = await pg.$queryRawUnsafe(`SELECT id, name, stock FROM products WHERE id IN (1, 9, 12, 14, 232) ORDER BY id`) as any[]
    const now = new Date()
    console.log('NOW', now.toISOString().slice(11, 19))
    upd.forEach((u: any) => console.log(' ', u.id, u.name, u.stock))
    // ALL events (any direction) after 09:00 touching product 1/9/12
    const evts = await pg.$queryRawUnsafe(`SELECT id, entity, "entityId", direction, status, "createdAt" FROM hybrid_events WHERE "createdAt" > '2026-10-03T09:00' ORDER BY id DESC LIMIT 20`) as any[]
    console.log(`events after 09:00: ${evts.length}`)
    evts.forEach((e: any) => console.log(' ', e.id, e.entity + '#' + e.entityId, e.direction, e.status, String(e.createdAt).slice(11, 19)))
  } finally { await pg.$disconnect() }
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1) })
