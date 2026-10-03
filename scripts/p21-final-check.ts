import { db } from '../src/lib/db'
import { PrismaClient as PgClient } from '../pgtmp-client'
import { neonPooledUrl } from './lib/env-local'
async function main() {
  const pending = await db.hybridEvent.count({ where: { direction: 'out', status: 'pending' } })
  console.log(`local outbox pending: ${pending}`)
  const pg = new PgClient({ datasources: { db: { url: neonPooledUrl() } } })
  try {
    const local = await db.$queryRaw<any[]>`SELECT id, name, stock FROM products WHERE id <= 19 ORDER BY id`
    const neon = await pg.$queryRawUnsafe(`SELECT id, name, stock FROM products WHERE id <= 19 ORDER BY id`) as any[]
    const lmap = new Map(local.map((p: any) => [p.id, p.stock]))
    let mismatches = 0
    neon.forEach((p: any) => {
      const match = Math.abs((lmap.get(p.id) ?? -999) - p.stock) < 0.01
      if (!match) { mismatches++; console.log(`  MISMATCH ${p.id} ${p.name}: local=${lmap.get(p.id)} neon=${p.stock}`) }
    })
    console.log(`old-ingredient stock parity: ${19 - mismatches}/19 match`)
    const p230 = await pg.$queryRawUnsafe(`SELECT COUNT(*) n FROM products WHERE id >= 230`) as any[]
    const rc = await pg.$queryRawUnsafe(`SELECT COUNT(*) n FROM recipe_components`) as any[]
    const cats = await pg.$queryRawUnsafe(`SELECT COUNT(*) n FROM categories`) as any[]
    console.log(`Neon: products>=230: ${p230[0].n} · recipe_components: ${rc[0].n} · categories: ${cats[0].n}`)
    const failed = await pg.$queryRawUnsafe(`SELECT COUNT(*) n FROM hybrid_events WHERE direction='in' AND status='failed'`) as any[]
    console.log(`Neon failed in-events remaining: ${failed[0].n}`)
  } finally { await pg.$disconnect() }
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1) })
