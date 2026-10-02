import { db } from '../src/lib/db'
async function main() {
  console.log('=== CATEGORIES ===')
  const cats = await db.category.findMany({ orderBy: { displayOrder: 'asc' }, select: { id: true, name: true, active: true, prepDestination: true, _count: { select: { products: true } } } })
  console.log(cats.map(c => `${c.id}:${c.name}(${c.active ? 'on' : 'off'}→${c.prepDestination ?? 'kitchen'},${c._count.products}p)`).join(' '))
  console.log('=== PRODUCTS total/active ===')
  console.log(await db.product.count(), '/', await db.product.count({ where: { active: true } }))
  console.log('=== HYBRID EVENTS ===')
  const ev = await db.hybridEvent.groupBy({ by: ['direction', 'status'], _count: { _all: true } })
  console.log(JSON.stringify(ev))
  console.log('=== KEY TABLE COUNTS ===')
  const counts: Record<string, number> = {}
  for (const [k, fn] of Object.entries({
    users: () => db.user.count(), products: () => db.product.count(), categories: () => db.category.count(),
    orders: () => db.order.count(), orderItems: () => db.orderItem.count(), payments: () => db.payment.count(),
    tables: () => db.restaurantTable.count(), floorPlans: () => db.floorPlan.count(),
    customers: () => db.customer.count(), reservations: () => db.reservation.count(),
    inventoryItems: () => db.inventoryItem.count(), invTx: () => db.inventoryTransaction.count(),
    suppliers: () => db.supplier.count(), purchaseOrders: () => db.purchaseOrder.count(),
    promotions: () => db.promotion.count(), modifierGroups: () => db.modifierGroup.count(),
    customRoles: () => db.customRole.count(), attendance: () => db.attendance.count(),
    cashDrawer: () => db.cashDrawerEntry.count(), waste: () => db.waste.count(),
    recipes: () => db.recipe.count(), auditLogs: () => db.auditLog.count(),
    visionEvents: () => db.visionEvent.count(), visionCameras: () => db.visionCamera.count(),
    visionZones: () => db.visionZone.count(), visionMovements: () => db.visionMovementCandidate.count(),
    outbox: () => db.hybridEvent.count(), devices: () => db.hybridDevice.count(),
    invoices: () => db.invoice.count(), stockCounts: () => db.stockCount.count(),
    appSettings: () => db.appSetting.count(),
  })) { try { counts[k] = await (fn as () => Promise<number>)() } catch { counts[k] = -1 } }
  console.log(JSON.stringify(counts))
  console.log('=== CUSTOM ROLES ===')
  for (const r of await db.customRole.findMany()) console.log(JSON.stringify({ id: r.id, name: r.name, active: r.active, perms: r.permissions }))
  console.log('=== OCCUPIED TABLES (open orders) ===')
  const open = await db.order.findMany({ where: { status: 'open' }, select: { id: true, tableId: true, orderType: true, createdAt: true }, take: 30 })
  console.log(JSON.stringify(open))
}
main().catch(e => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
