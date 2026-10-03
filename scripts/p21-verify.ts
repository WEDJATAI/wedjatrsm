import { PrismaClient as PgClient } from '../pgtmp-client'
import { neonPooledUrl } from './lib/env-local'
async function main() {
  const pg = new PgClient({ datasources: { db: { url: neonPooledUrl() } } })
  try {
    const p230 = await pg.$queryRawUnsafe(`SELECT COUNT(*) n FROM products WHERE id >= 230`) as any[]
    console.log('Neon products >= 230:', p230[0].n)
    const rc = await pg.$queryRawUnsafe(`SELECT COUNT(*) n FROM recipe_components`) as any[]
    console.log('Neon recipe_components:', rc[0].n)
    const cheese = await pg.$queryRawUnsafe(`SELECT stock, low_stock_threshold FROM products WHERE id = 9`) as any[]
    console.log('Neon cheese stock/threshold:', JSON.stringify(cheese))
    const failed = await pg.$queryRawUnsafe(`SELECT entity, COUNT(*) n FROM hybrid_events WHERE direction='in' AND status='failed' GROUP BY entity ORDER BY n DESC`) as any[]
    failed.forEach((f: any) => console.log('failed in-events:', f.entity, f.n))
    const cf = await pg.$queryRawUnsafe(`SELECT rc.quantity, p.name FROM recipe_components rc JOIN products p ON p.id = rc.ingredient_id WHERE rc.product_id = 71`) as any[]
    console.log('Neon Cheese Fries (71) recipe:', JSON.stringify(cf))
  } finally { await pg.$disconnect() }
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1) })
