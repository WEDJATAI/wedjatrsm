import { db } from '../../src/lib/db'
const state = await db.hybridSyncState.findMany({ orderBy: { key: 'asc' } })
for (const s of state) console.log(`${s.key} = ${s.value.slice(0, 120)}`)
const counts = {
  pending: await db.hybridEvent.count({ where: { direction: 'out', status: 'pending' } }),
  inflight: await db.hybridEvent.count({ where: { direction: 'out', status: 'inflight' } }),
  failed: await db.hybridEvent.count({ where: { direction: 'out', status: 'failed' } }),
  acked: await db.hybridEvent.count({ where: { direction: 'out', status: 'acked' } }),
  inApplied: await db.hybridEvent.count({ where: { direction: 'in', status: 'applied' } }),
}
console.log('OUTBOX', JSON.stringify(counts))
await db.$disconnect()
