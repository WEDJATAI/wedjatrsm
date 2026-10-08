import { db } from '../../src/lib/db'
const lo = await db.order.findMany({ where: { id: { in: [133, 317, 323] } }, select: { id: true, originDeviceId: true, customerId: true, userId: true } })
console.log('LOCAL order origins:', JSON.stringify(lo))
const dev = await db.hybridSyncState.findUnique({ where: { key: 'local.deviceId' } })
console.log('local deviceId:', dev?.value)
// also all orders with customerId 2 or 3
const all = await db.order.findMany({ where: { customerId: { in: [2, 3] } }, select: { id: true, customerId: true, createdAt: true, status: true }, orderBy: { id: 'asc' } })
console.log('ALL local orders w/ customerId 2/3:', JSON.stringify(all))
await db.$disconnect()
