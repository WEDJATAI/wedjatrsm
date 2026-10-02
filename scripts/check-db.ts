import { db } from '../src/lib/db'
async function main() {
  const settings = await db.appSetting.findMany()
  console.log('SETTINGS:', JSON.stringify(settings))
  const tables = await db.restaurantTable.count()
  console.log('TABLES:', tables)
  const openOrders = await db.order.findMany({ where: { status: 'open' }, select: { id: true, tableId: true } })
  console.log('OPEN ORDERS:', openOrders.length)
  const users = await db.user.findMany({ select: { id: true, email: true, role: true, pin: true } })
  console.log('USERS:', JSON.stringify(users))
  const plans = await db.floorPlan.findMany({ select: { id: true, name: true } })
  console.log('FLOORPLANS:', JSON.stringify(plans))
  console.log('TOTAL ORDERS:', await db.order.count())
}
main().catch((e) => console.error(e)).finally(() => db.$disconnect())
