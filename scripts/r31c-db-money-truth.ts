/**
 * r31c — DB-level truth for the money-math check (read-only, no src/ changes).
 * The API said paid orders #108/#126/#127 have items:[] payments:[] — verify
 * against SQLite directly and find paid orders WITH payment rows for the
 * money-math verification. Also capture the stock-count cancel 500 evidence.
 */
import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'

const db = new PrismaClient({ adapter: new PrismaLibSql({ url: (process.env.DATABASE_URL ?? 'file:./db/custom.db').split('?')[0] }), log: ['error'] }) // r49: Prisma 7 adapter
const round2 = (n: number) => Math.round(n * 100) / 100

async function main() {
  const paid = await db.order.findMany({
    where: { status: 'paid' },
    orderBy: { id: 'asc' },
    include: { items: true, payments: true },
  })
  console.log(`paid orders total: ${paid.length}`)
  const withPayments = paid.filter((o) => o.payments.length > 0)
  const withItems = paid.filter((o) => o.items.length > 0)
  console.log(`paid with payments: ${withPayments.length}; paid with items: ${withItems.length}`)
  console.log(`paid WITHOUT payments: ${paid.filter((o) => o.payments.length === 0).map((o) => o.id).join(', ') || 'none'}`)
  console.log(`paid WITHOUT items: ${paid.filter((o) => o.items.length === 0).map((o) => o.id).join(', ') || 'none'}`)

  // recent paid orders with items+payments — pick up to 5 newest for math check
  const sample = withPayments.filter((o) => o.items.length > 0).slice(-5).reverse()
  console.log(`\nmoney-math sample (newest paid w/ items+payments): ${sample.map((o) => o.id).join(', ')}`)
  for (const o of sample) {
    const calcSub = round2(o.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0))
    const discount = o.discountAmount ?? 0
    const base = round2(calcSub - discount)
    const calcTax = round2(base * 0.14)
    const calcSvc = round2(base * 0.12)
    const calcTotal = round2(base + calcTax + calcSvc)
    const netPaid = round2(o.payments.reduce((s, p) => s + p.amount, 0))
    const ok = (a: number, b: number) => Math.abs(a - b) < 0.02
    console.log(
      `#${o.id}: sub ${o.subtotalAmount}/${calcSub}${ok(o.subtotalAmount, calcSub) ? '✓' : '✗'} ` +
      `disc ${discount} tax ${o.taxAmount}/${calcTax}${ok(o.taxAmount, calcTax) ? '✓' : '✗'} ` +
      `svc ${o.serviceTaxAmount}/${calcSvc}${ok(o.serviceTaxAmount, calcSvc) ? '✓' : '✗'} ` +
      `total ${o.totalAmount}/${calcTotal}${ok(o.totalAmount, calcTotal) ? '✓' : '✗'} ` +
      `netPaid ${netPaid}${ok(netPaid, o.totalAmount) ? '✓' : '✗'} ` +
      `items ${o.items.map((i) => `${i.quantity}×${i.unitPrice}`).join('+')} ` +
      `pays ${o.payments.map((p) => `${p.method}:${p.amount}`).join('+')}`,
    )
  }

  // any order (any status) whose items sum mismatches stored subtotal?
  let mismatched = 0
  const all = await db.order.findMany({ include: { items: true, payments: true } })
  for (const o of all) {
    const calcSub = round2(o.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0))
    if (Math.abs(calcSub - o.subtotalAmount) >= 0.02) mismatched++
  }
  console.log(`\nall orders: ${all.length}; subtotal-vs-items mismatch: ${mismatched}`)

  // deferred / open orders with payments?
  const deferred = all.filter((o) => o.status === 'deferred')
  console.log(`deferred orders: ${deferred.map((o) => `#${o.id} paid=${round2(o.payments.reduce((s, p) => s + p.amount, 0))} total=${o.totalAmount}`).join(', ') || 'none'}`)

  // stock counts state (my probe artifact + the 500)
  const scs = await db.stockCount.findMany({ orderBy: { id: 'desc' }, take: 5 })
  console.log(`\nstock counts: ${scs.map((s) => `#${s.id} ${s.number} ${s.status}`).join(', ')}`)

  // paid orders count by month (are the empty ones old seed rows?)
  const emptyPaid = paid.filter((o) => o.payments.length === 0)
  if (emptyPaid.length) {
    console.log(`\npaid-without-payments dates: ${emptyPaid.map((o) => `#${o.id} ${o.createdAt.toISOString().slice(0, 10)}`).join(', ')}`)
  }
  await db.$disconnect()
}

main().catch((e) => { console.error(e); process.exit(1) })
