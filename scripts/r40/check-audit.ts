import { db } from '../../src/lib/db'
for (const a of await db.auditLog.findMany({ orderBy: { id: 'asc' } }))
  console.log(`  #${a.id} user=${a.userId ?? '-'} "${a.userName}" action=${a.action} entity=${a.entity}/${a.entityId ?? '-'} at=${a.createdAt.toISOString().slice(0,19)}\n     details=${a.details?.slice(0, 120) ?? '-'}`)
console.log('promotions count:', await db.promotion.count())
await db.$disconnect()
