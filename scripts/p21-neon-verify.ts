import { PrismaClient as PgClient } from '../pgtmp-client'
import { neonPooledUrl } from './lib/env-local'
async function main() {
  const pg = new PgClient({ datasources: { db: { url: neonPooledUrl() } } })
  try {
    const p230 = await pg.$queryRawUnsafe(`SELECT COUNT(*) n FROM products WHERE id >= 230`) as any[]
    console.log('Neon products >= 230:', p230[0].n)
    const rc = await pg.$queryRawUnsafe(`SELECT COUNT(*) n FROM recipe_components`) as any[]
    console.log('Neon recipe_components:', rc[0].n)
    const failed = await pg.$queryRawUnsafe(`SELECT entity, COUNT(*) n FROM hybrid_events WHERE direction='in' AND status='failed' GROUP BY entity`) as any[]
    failed.forEach((f: any) => console.log('Neon failed in-events:', f.entity, f.n))
    // cheese stock check
    const cheese = await pg.$queryRawUnsafe(`SELECT id, name, stock, low_stock_threshold FROM products WHERE id = 9`) as any[]
    console.log('Neon cheese:', JSON.stringify(cheese))
    // sample recipe: cheese fries (71) with the 25g cheese line
    const cf = await pg.$queryRawUnsafe(`SELECT rc.quantity, p.name FROM recipe_components rc JOIN products p ON p.id = rc.ingredient_id WHERE rc.product_id = 71`) as any[]
    console.log('Neon Cheese Fries recipe:', JSON.stringify(cf))
    // sequences ahead of explicit ids
    await pg.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('products','id'), GREATEST((SELECT MAX(id) FROM products), 1))`)
    await pg.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('recipe_components','id'), GREATEST((SELECT MAX(id) FROM recipe_components), 1))`)
    await pg.$executeRawUnsafe(`SELECT setval(pg_get_serial_sequence('inventory_transactions','id'), GREATEST((SELECT MAX(id) FROM inventory_transactions), 1))`)
    console.log('sequences synced: products, recipe_components, inventory_transactions')
  } finally { await pg.$disconnect() }
}
main().then(() => process.exit(0)).catch(e => { console.error(e.message); process.exit(1) })
