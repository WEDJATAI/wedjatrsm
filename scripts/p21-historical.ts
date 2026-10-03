import { PrismaClient as PgClient } from '../pgtmp-client'
import { neonPooledUrl } from './lib/env-local'
async function main() {
  const pg = new PgClient({ datasources: { db: { url: neonPooledUrl() } } })
  try {
    const remaining = await pg.$queryRawUnsafe(`SELECT COUNT(*) n FROM hybrid_events WHERE direction='in' AND status='failed'`) as any[]
    console.log('remaining failed in-events:', remaining[0].n)
    // which historical (pre-today) events HEALED today? check status changes... check applied with old createdAt
    const healed = await pg.$queryRawUnsafe(`SELECT entity, COUNT(*) n FROM hybrid_events WHERE direction='in' AND status='applied' AND "createdAt" < '2026-10-03' GROUP BY entity`) as any[]
    console.log('pre-today in-events now applied (healed by self-healing):')
    healed.forEach((h: any) => console.log(' ', h.entity, h.n))
    // distinct product stock stomps: current values for old ingredients
    const stomped = await pg.$queryRawUnsafe(`SELECT id, name, stock FROM products WHERE id <= 19 ORDER BY id`) as any[]
    stomped.forEach((p: any) => console.log(' ', p.id, p.name, p.stock))
  } finally { await pg.$disconnect() }
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1) })
