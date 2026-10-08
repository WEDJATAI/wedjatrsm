/**
 * r38 baseline — local DB counts + hybrid outbox + sync state snapshot.
 * Read-only. Uses Prisma (same pattern as all prior rounds).
 */
import { db } from '../../src/lib/db'

async function main() {
  const counts = {
    users: await db.user.count(),
    products: await db.product.count(),
    orders: await db.order.count(),
    payments: await db.payment.count(),
    customers: await db.customer.count(),
    tables: await db.restaurantTable.count(),
    outboxPending: await db.hybridEvent.count({ where: { direction: 'out', status: 'pending' } }),
    outboxFailed: await db.hybridEvent.count({ where: { direction: 'out', status: 'failed' } }),
    outboxDead: await db.hybridEvent.count({ where: { direction: 'out', status: 'dead' } }),
    outboxTotal: await db.hybridEvent.count({ where: { direction: 'out' } }),
    openOrders: await db.order.count({ where: { status: { notIn: ['CANCELLED', 'PAID'] } } }),
  }
  console.log('BASELINE_COUNTS', JSON.stringify(counts))

  const state = await db.hybridSyncState.findMany({ orderBy: { key: 'asc' } })
  for (const s of state) console.log(`SYNC_STATE ${s.key} = ${s.value.slice(0, 250)}`)

  const appSync = await db.appSetting.findMany({
    where: { key: { startsWith: 'sync.' } },
    orderBy: { key: 'asc' },
  })
  for (const s of appSync) console.log(`APP_SETTING ${s.key} = ${s.value.slice(0, 250)}`)

  const lastEvents = await db.hybridEvent.findMany({
    orderBy: { id: 'desc' },
    take: 5,
    select: { id: true, operation: true, entityId: true, status: true, createdAt: true }, // r49: column renamed type→operation
  })
  console.log('LAST_OUTBOX', JSON.stringify(lastEvents))

  const devices = await db.hybridDevice.findMany({
    select: { deviceId: true, name: true, status: true, lastPushAt: true, lastPullAt: true },
  })
  console.log('DEVICES', JSON.stringify(devices))
}

main()
  .catch((e) => {
    console.error('FAILED:', e)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
