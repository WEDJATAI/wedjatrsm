import { db } from '../src/lib/db'
import { PrismaClient as PgClient } from '../pgtmp-client'
import { neonPooledUrl } from './lib/env-local'
async function main() {
  // my product-create events locally
  const mine = await db.$queryRaw<any[]>`select "eventId", "entityId", status, "ackedAt" from hybrid_events where direction='out' and entity='Product' and "entityId" >= 230 order by id limit 5`
  for (const m of mine) console.log('local out:', m.eventId, 'Product#' + m.entityId, m.status, String(m.ackedAt).slice(0, 19))
  const pg = new PgClient({ datasources: { db: { url: neonPooledUrl() } } })
  try {
    for (const m of mine) {
      const rows = await pg.$queryRawUnsafe(`SELECT "eventId", entity, "entityId", status, "lastError", "createdAt" FROM hybrid_events WHERE "eventId" = $1`, m.eventId) as any[]
      if (rows.length === 0) console.log('  -> NOT on Neon:', m.eventId)
      else rows.forEach((r: any) => console.log('  -> Neon:', r.eventId?.slice(0, 8), r.status, 'err:', (r.lastError ?? '').slice(0, 60), String(r.createdAt).slice(0, 19)))
    }
    // today's failed in-events count
    const today = await pg.$queryRawUnsafe(`SELECT entity, COUNT(*) n FROM hybrid_events WHERE direction='in' AND status='failed' AND "createdAt" > '2026-10-03' GROUP BY entity`) as any[]
    today.forEach((f: any) => console.log('TODAY failed in-events:', f.entity, f.n))
  } finally { await pg.$disconnect() }
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1) })
