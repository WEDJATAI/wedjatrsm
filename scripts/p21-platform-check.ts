import { db } from '../src/lib/db'
import { PrismaClient as PgClient } from '../pgtmp-client'
import { neonPooledUrl } from './lib/env-local'
async function main() {
  const pg = new PgClient({ datasources: { db: { url: neonPooledUrl() } } })
  try {
    const shifts = await pg.$queryRawUnsafe(`SELECT id, name, start_time, end_time, active FROM shifts ORDER BY id`) as any[]
    console.log('Neon shifts:', shifts.length ? shifts.map((s: any) => `${s.name} ${s.start_time}-${s.end_time}`).join(' | ') : 'NONE')
    const rc = await pg.$queryRawUnsafe(`SELECT COUNT(*) n FROM recipe_components`) as any[]
    const p = await pg.$queryRawUnsafe(`SELECT COUNT(*) n FROM products`) as any[]
    const failed = await pg.$queryRawUnsafe(`SELECT COUNT(*) n FROM hybrid_events WHERE status='failed'`) as any[]
    console.log(`Neon: products=${p[0].n} recipes=${rc[0].n} failed-events=${failed[0].n}`)
    const cheese = await pg.$queryRawUnsafe(`SELECT stock FROM products WHERE id=9`) as any[]
    console.log('Neon cheese stock:', cheese[0].stock)
  } finally { await pg.$disconnect() }
  const localRc = await db.recipeComponent.count()
  const localP = await db.product.count()
  console.log(`LOCAL: products=${localP} recipes=${localRc}`)
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1) })
