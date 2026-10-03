import { PrismaClient as PgClient } from '../pgtmp-client'
import { neonPooledUrl } from './lib/env-local'
async function main() {
  const pg = new PgClient({ datasources: { db: { url: neonPooledUrl() } } })
  try {
    const rows = await pg.$queryRawUnsafe(`SELECT "eventId", entity, "entityId", "lastError", "createdAt", substr(payload, 1, 80) p FROM hybrid_events WHERE direction='in' AND status='failed' AND entity IN ('Order','OrderItem') AND "createdAt" > '2026-10-03' ORDER BY id`) as any[]
    rows.forEach((r: any) => console.log(r.entity + '#' + r.entityId, 'err=' + r.lastError, String(r.createdAt).slice(0, 19), (r.p ?? '').replace(/\s+/g, ' ').slice(0, 70)))
    // any failed in-events BEFORE today? (historical 252)
    const old = await pg.$queryRawUnsafe(`SELECT COUNT(*) n FROM hybrid_events WHERE direction='in' AND status='failed' AND "createdAt" < '2026-10-03'`) as any[]
    console.log('historical (pre-today) failed in-events:', old[0].n)
  } finally { await pg.$disconnect() }
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1) })
