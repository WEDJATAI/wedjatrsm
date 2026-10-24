import { db } from '../../src/lib/db'
const locals = await db.customer.findMany({ select: { id: true, name: true, phone: true, visits: true, points: true }, orderBy: { id: 'asc' } })
console.log(`LOCAL customers (${locals.length}):`)
for (const c of locals) console.log(`  #${c.id} ${c.name} ${c.phone ?? ''} visits=${c.visits} pts=${c.points}`)
await db.$disconnect()
