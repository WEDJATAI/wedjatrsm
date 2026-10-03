import { db } from '../src/lib/db'
async function main() {
  for (const id of [42, 45, 46, 49, 50, 55, 56, 57, 59, 63, 67, 73, 81, 335, 336, 337]) {
    const o = await db.order.findUnique({ where: { id }, select: { id: true, totalAmount: true, status: true, payments: { select: { amount: true, method: true } } } })
    if (!o) { console.log(`#${id}: MISSING`); continue }
    const paid = o.payments.reduce((s, p) => s + p.amount, 0)
    console.log(`#${id} status=${o.status} total=${o.totalAmount} payments=${o.payments.length} sum=${Math.round(paid * 100) / 100} ${o.payments.map(p => p.method + ':' + p.amount).join(',')}`)
  }
}
main().catch(e => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
