import { db } from '../../src/lib/db'
const c4 = await db.customer.findUnique({ where: { id: 4 } })
console.log('LOCAL customer 4:', c4 ? `${c4.name} / ${c4.phone} / notes=${JSON.stringify(c4.notes)}` : 'MISSING')
const probe = await db.customer.findMany({ where: { name: { contains: 'R38' } }, select: { id: true, name: true, phone: true } })
console.log('LOCAL R38 customers:', JSON.stringify(probe))
const inEv = await db.hybridEvent.findMany({
  where: { direction: 'in', entity: 'Customer' },
  orderBy: { id: 'desc' },
  take: 3,
  select: { eventId: true, entityId: true, operation: true, status: true, lastError: true },
})
console.log('LOCAL in-events Customer:', JSON.stringify(inEv))
const cursor = await db.hybridSyncState.findUnique({ where: { key: 'pull.cursor' } })
const rem = await db.hybridSyncState.findUnique({ where: { key: 'pull.remaining' } })
const lastPull = await db.hybridSyncState.findUnique({ where: { key: 'lastPullAt' } })
console.log('cursor:', cursor?.value, 'remaining:', rem?.value, 'lastPullAt:', lastPull?.value)
await db.$disconnect()
