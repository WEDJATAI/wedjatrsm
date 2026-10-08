import { db } from '../../src/lib/db'
const failed = await db.hybridEvent.findMany({ where: { status: { in: ['failed', 'dead'] } }, orderBy: { id: 'asc' } })
for (const e of failed)
  console.log(`  #${e.id} ${e.direction}/${e.status} ${e.entity}/${e.entityId} ${e.operation} rev=${e.revision} attempts=${e.attempts} at=${e.createdAt.toISOString().slice(0,19)}\n     err=${e.lastError?.slice(0, 140) ?? '-'}`)
await db.$disconnect()
