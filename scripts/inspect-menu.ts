import { db } from '../src/lib/db'
async function main() {
  const cats = await db.category.findMany({ orderBy: { displayOrder: 'asc' } })
  console.log('CATEGORIES:', cats.map(c => `${c.id}|${c.name}`).join('  '))
  const prods = await db.product.findMany({ orderBy: { id: 'asc' }, select: { id: true, name: true, categoryId: true, isSellable: true, isStockable: true } })
  console.log('PRODUCTS:')
  for (const p of prods) console.log(`${p.id}|${p.name}|cat=${p.categoryId}|sell=${p.isSellable}|stock=${p.isStockable}`)
}
main().then(() => process.exit(0))
