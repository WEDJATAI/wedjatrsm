import { PrismaClient as PgClient } from '../pgtmp-client'
import { PrismaPg } from '@prisma/adapter-pg'
import { neonPooledUrl } from './lib/env-local'
async function main() {
  const pg = new PgClient({ adapter: new PrismaPg({ connectionString: neonPooledUrl() }) })
  try {
    // find the cloud's in-events for the failing entities, newest first
    const rows = await pg.$queryRawUnsafe(`SELECT "eventId", entity, "entityId", status, "lastError", "createdAt" FROM hybrid_events WHERE direction='in' AND entity='RecipeComponent' ORDER BY id DESC LIMIT 5`) as any[]
    rows.forEach((r: any) => console.log('evt', r.eventId?.slice(0, 12), 'RecipeComponent#' + r.entityId, r.status, 'err:', (r.lastError ?? '').slice(0, 200)))
    const prods = await pg.$queryRawUnsafe(`SELECT "eventId", entity, "entityId", status, "lastError" FROM hybrid_events WHERE direction='in' AND entity='Product' AND "entityId" >= 230 ORDER BY id DESC LIMIT 5`) as any[]
    prods.forEach((r: any) => console.log('evt', r.eventId?.slice(0, 12), 'Product#' + r.entityId, r.status, 'err:', (r.lastError ?? '').slice(0, 200)))
    const count230 = await pg.$queryRawUnsafe(`SELECT COUNT(*) n FROM products WHERE id >= 230`) as any[]
    console.log('Neon products with id >= 230:', count230[0].n)
    const rc = await pg.$queryRawUnsafe(`SELECT COUNT(*) n FROM recipe_components`) as any[]
    console.log('Neon recipe_components:', rc[0].n)
  } finally { await pg.$disconnect() }
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1) })
