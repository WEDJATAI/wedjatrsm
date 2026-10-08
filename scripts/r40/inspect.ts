import { db } from '../../src/lib/db'
import { isDeletedEmail } from '../../src/lib/user-deletion'

async function main() {
  console.log('=== USERS (local) ===')
  const users = await db.user.findMany({ orderBy: { id: "asc" } })
  for (const u of users) {
    const orderCount = await db.order.count({ where: { userId: u.id } })
    console.log(`#${u.id} role=${u.role} super=${u.isSuperAdmin} email=${u.email} name="${u.name}" active=${u.active} tombstone=${isDeletedEmail(u.email)} pin=${u.pin ? 'yes' : 'no'} orders=${orderCount} created=${u.createdAt.toISOString().slice(0, 10)}`)
  }
  console.log('\n=== PERSONS ===')
  for (const p of await db.person.findMany({ orderBy: { id: "asc" } }))
    console.log(`#${p.id} user=${p.userId} name="${p.name}" active=${p.active} created=${p.createdAt.toISOString().slice(0, 10)}`)

  console.log('\n=== ORDERS by status ===')
  const byStatus = await db.$queryRawUnsafe<{status: string, c: number}[]>('select status, count(*) c from orders group by status')
  for (const g of byStatus) console.log(`  ${g.status}: ${g.c}`)
  const openOrders = await db.order.findMany({ where: { status: 'open' }, select: { id: true, tableId: true, totalAmount: true, createdAt: true } })
  console.log('  OPEN:', JSON.stringify(openOrders))
  const deferred = await db.order.findMany({ where: { status: 'deferred' }, select: { id: true, tableId: true, clientName: true, totalAmount: true } })
  console.log('  DEFERRED:', JSON.stringify(deferred))
  console.log('  date range:', (await db.order.findFirst({ orderBy: { id: "asc" } }))?.createdAt?.toISOString().slice(0, 10), '→', (await db.order.findFirst({ orderBy: { id: "desc" } }))?.createdAt?.toISOString().slice(0, 10))

  console.log('\n=== TABLES ===')
  for (const t of await db.restaurantTable.findMany({ orderBy: { id: "asc" } }))
    console.log(`  T${t.id} "${t.name}" status=${t.status} active=${t.active} floor=${t.floorPlanId}`)

  console.log('\n=== COUNTS (all models) ===')
  const models = ['order','orderItem','payment','customer','category','product','modifierGroup','modifier','productModifierGroup','recipeComponent','inventoryTransaction','stockCount','stockCountLine','purchaseOrder','purchaseOrderItem','supplier','attendance','wasteLog','auditLog','reservation','restaurantTable','floorPlan','customRole','promotion','person','user','cashDrawerSession','cashDrawerEntry','shift','appSetting','visionCamera','visionZone','visionEvent','visionTableState','movementCandidate','hybridDevice','hybridEvent','hybridConflict','hybridSyncState']
  for (const m of models) {
    try { console.log(`  ${m}: ${await (db as any)[m].count()}`) } catch (e: any) { console.log(`  ${m}: ERR ${e.message.slice(0, 60)}`) }
  }

  console.log('\n=== HYBRID EVENTS by direction/status ===')
  const ev = await db.$queryRawUnsafe<{direction: string, status: string, c: number}[]>('select direction, status, count(*) c from hybrid_events group by direction, status')
  for (const g of ev) console.log(`  ${g.direction}/${g.status}: ${g.c}`)

  console.log('\n=== DEVICES ===')
  for (const d of await db.hybridDevice.findMany()) console.log(`  ${d.deviceId.slice(0, 12)}… "${d.name}" platform=${d.platform} status=${d.status} lastPull=${d.lastPullAt?.toISOString()}`)

  console.log('\n=== SYNC STATE ===')
  for (const s of await db.hybridSyncState.findMany()) console.log(`  ${s.key} = ${s.value.slice(0, 90)}`)

  console.log('\n=== PROMOTIONS ===')
  for (const p of await db.promotion.findMany()) console.log(`  #${p.id} "${p.name}" type=${p.type} value=${p.value} scope=${p.scope} active=${p.active} window=${p.startDate?.toISOString().slice(0,10) ?? '∞'}→${p.endDate?.toISOString().slice(0,10) ?? '∞'} days=${p.daysOfWeek} time=${p.startTime ?? '-'}–${p.endTime ?? '-'}`)

  console.log('\n=== CUSTOMERS ===')
  for (const c of await db.customer.findMany()) console.log(`  #${c.id} "${c.name}" phone=${c.phone} visits=${c.visits} pts=${c.points} spent=${c.totalSpent} created=${c.createdAt.toISOString().slice(0,10)}`)

  console.log('\n=== SUPPLIERS / POs / STOCKCOUNTS ===')
  for (const s of await db.supplier.findMany()) console.log(`  supplier #${s.id} "${s.name}" phone=${s.phone}`)
  for (const p of await db.purchaseOrder.findMany()) console.log(`  PO #${p.id} ${p.number} status=${p.status} supplier=${p.supplierId}`)
  for (const s of await db.stockCount.findMany()) console.log(`  SC #${s.id} ${s.number} status=${s.status}`)

  console.log('\n=== CATEGORIES (menu) ===')
  for (const c of await db.category.findMany({ orderBy: { id: "asc" } })) {
    const n = await db.product.count({ where: { categoryId: c.id } })
    console.log(`  #${c.id} "${c.name}" ar=${c.nameAr ?? '-'} active=${c.active} products=${n} order=${c.displayOrder}`)
  }
  const prods = await db.product.findMany({ where: { active: true } })
  const sellable = prods.filter(p => p.isSellable).length
  const ingredients = prods.filter(p => !p.isSellable).length
  console.log(`  PRODUCTS: total active=${prods.length} sellable=${sellable} ingredients=${ingredients}`)
  console.log(`  sample: ${prods.slice(0, 5).map(p => `#${p.id}${p.name}`).join(' | ')}`)

  console.log('\n=== RESERVATIONS ===')
  for (const r of await db.reservation.findMany()) console.log(`  #${r.id} "${r.customerName}" ${r.status} at=${r.reservedAt.toISOString().slice(0, 16)}`)

  console.log('\n=== ROLES ===')
  for (const r of await db.customRole.findMany()) console.log(`  #${r.id} "${r.name}" active=${r.active} perms=${r.permissions.slice(0, 50)}`)

  console.log('\n=== WASTELOGS ===')
  for (const w of await db.wasteLog.findMany()) console.log(`  #${w.id} product=${w.productId} qty=${w.quantity} reason=${w.reason} at=${w.createdAt.toISOString().slice(0, 10)}`)

  console.log('\n=== ATTENDANCE ===')
  for (const a of await db.attendance.findMany()) console.log(`  #${a.id} user=${a.userId} in=${a.checkInAt.toISOString().slice(0, 16)} out=${a.checkOutAt?.toISOString().slice(0, 16) ?? 'OPEN'}`)

  await db.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
