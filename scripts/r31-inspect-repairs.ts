import { db } from '../src/lib/db'
async function main() {
  const zombies = await db.order.findMany({ where: { status: 'open', totalAmount: 0 }, select: { id: true, createdAt: true, orderType: true, tableId: true, _count: { select: { items: true } } } })
  console.log('ZOMBIES (open, total=0):', JSON.stringify(zombies))
  const stale = await db.order.findMany({ where: { status: 'open', tableId: null, createdAt: { lt: new Date('2026-10-01') } }, select: { id: true, createdAt: true, totalAmount: true, externalRef: true, _count: { select: { items: true, payments: true } } } })
  console.log('STALE OPEN TAKEAWAYS (<Oct 1):', stale.length)
  for (const s of stale) console.log(`  #${s.id} ${s.createdAt.toISOString().slice(0, 16)} total=${s.totalAmount} items=${s._count.items} pays=${s._count.payments} ref=${s.externalRef ?? '-'}`)
  const o40 = await db.order.findUnique({ where: { id: 40 }, include: { items: { select: { quantity: true, unitPrice: true } }, payments: { select: { amount: true, method: true } } } })
  if (o40) {
    const itemsSum = o40.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0)
    const paidSum = o40.payments.reduce((s, p) => s + p.amount, 0)
    console.log('ORDER 40: stored sub', o40.subtotalAmount, 'total', o40.totalAmount, '| items sum', Math.round(itemsSum * 100) / 100, '| items', o40.items.length, '| status', o40.status, '| table', o40.tableId, '| paid rows', o40.payments.length, 'sum', paidSum)
  }
  const o87 = await db.order.findUnique({ where: { id: 87 }, select: { id: true, orderType: true, tableId: true, status: true, createdAt: true, totalAmount: true } })
  console.log('ORDER 87:', JSON.stringify(o87))
  const paidNoPay = await db.order.findMany({ where: { status: 'paid', payments: { none: {} } }, select: { id: true, createdAt: true, totalAmount: true, closedAt: true }, orderBy: { id: 'asc' } })
  console.log('PAID WITH NO PAYMENT ROWS:', paidNoPay.length)
  const ids = paidNoPay.map(o => o.id)
  console.log('ids:', JSON.stringify(ids))
  if (paidNoPay[0]) console.log('sample:', JSON.stringify({ ...paidNoPay[0], createdAt: paidNoPay[0].createdAt.toISOString().slice(0, 16) }))
  const openOnTables = await db.order.findMany({ where: { status: 'open', tableId: { not: null } }, include: { items: { select: { quantity: true, unitPrice: true } } } })
  for (const o of openOnTables) {
    const sum = Math.round(o.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0) * 100) / 100
    if (Math.abs(sum - o.subtotalAmount) > 0.02) console.log('MISMATCH order', o.id, 'table', o.tableId, 'stored sub', o.subtotalAmount, 'items sum', sum)
  }
  console.log('mismatch scan done for', openOnTables.length, 'open table orders')
}
main().catch(e => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
