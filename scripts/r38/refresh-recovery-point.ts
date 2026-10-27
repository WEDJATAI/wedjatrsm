import { db } from '../../src/lib/db'
// VACUUM INTO a fresh consistent snapshot → the git-tracked recovery point
await db.$executeRawUnsafe(`VACUUM INTO '/home/z/my-project/download/rsm-platform-database.db'`.replace('download/rsm-platform-database.db', 'db/.r38-refresh.db'))
const { copyFileSync, statSync } = await import('node:fs')
copyFileSync('/home/z/my-project/db/.r38-refresh.db', '/home/z/my-project/download/rsm-platform-database.db')
const { unlinkSync } = await import('node:fs')
unlinkSync('/home/z/my-project/db/.r38-refresh.db')
const s = statSync('/home/z/my-project/download/rsm-platform-database.db')
console.log('recovery point refreshed:', s.size, 'bytes')
const counts = {
  users: await db.user.count(),
  products: await db.product.count(),
  orders: await db.order.count(),
  payments: await db.payment.count(),
  customers: await db.customer.count(),
}
console.log('RECOVERY_POINT_COUNTS', JSON.stringify(counts))
await db.$disconnect()
