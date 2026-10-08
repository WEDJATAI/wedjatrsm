/**
 * R31 (Task 2-b) — post-stress data-integrity verification.
 *
 * Reads the stress-suite artifacts:
 *   /tmp/r31-stress-baseline.json   (captured before ANY test write)
 *   /tmp/r31-stress-order-ids.json  (every order id the harness created)
 * and verifies the platform owner's ZERO-DATA-LOSS contract:
 *   1. order count after == baseline + created (cancelled rows stay by design)
 *   2. every created test order is status 'cancelled' and has ZERO payments
 *      (+ orphan scan: any order id > baseline max that the harness did NOT
 *      record — i.e. a create that answered 500 AFTER committing)
 *   3. orderItems of created test orders exist with quantity > 0
 *   4. no pre-existing order lost (count of id <= baseline max unchanged)
 *   5. hybrid outbox: no NEW 'dead' events (baseline: exactly 1 documented)
 *   6. money math on the created-then-cancelled orders (items vs totals,
 *      14% VAT + 12% service tax per src/lib/constants)
 *   7. dev server still answers 200 on GET /
 *
 * READ-ONLY: this script never writes to the database.
 * Usage: NODE_ENV=production bun scripts/r31-integrity.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { db } from '../src/lib/db'
import { TAX_RATE, SERVICE_TAX_RATE, MONEY_EPSILON } from '../src/lib/constants'

const BASE = 'http://localhost:3000'
const baseline = JSON.parse(readFileSync('/tmp/r31-stress-baseline.json', 'utf8')) as {
  orderCount: number
  maxOrderId: number | null
  cancelledCount: number
  paymentsCount: number
  hybridEvents: { direction: string; status: string; count: number }[]
  deadOutEvents: number
}
const idsDoc = JSON.parse(readFileSync('/tmp/r31-stress-order-ids.json', 'utf8')) as {
  createdCount: number
  ids: number[]
}
const createdIds = idsDoc.ids

type Check = { id: number; name: string; pass: boolean; detail: string }
const checks: Check[] = []
const round2 = (n: number) => Math.round(n * 100) / 100

async function main(): Promise<void> {
  // ── 1. order count: before vs after ─────────────────────────────
  const afterCount = await db.order.count()
  const expected = baseline.orderCount + createdIds.length
  const orphans = await db.order.findMany({
    where: { id: { gt: baseline.maxOrderId ?? 0 } },
    orderBy: { id: 'asc' },
    select: { id: true, status: true, orderType: true, subtotalAmount: true, totalAmount: true, createdAt: true },
  })
  const recordedSet = new Set(createdIds)
  const orphanRows = orphans.filter((o) => !recordedSet.has(o.id))
  checks.push({
    id: 1,
    name: `order count after (${afterCount}) == baseline (${baseline.orderCount}) + created (${createdIds.length})`,
    pass: afterCount === expected,
    detail:
      afterCount === expected
        ? 'exact — every created order (incl. cancelled) still present'
        : `MISMATCH: +${afterCount - baseline.orderCount} rows vs +${createdIds.length} recorded → ${orphanRows.length} UNRECORDED order(s): ${orphanRows.map((o) => `#${o.id} status=${o.status} totals=${o.subtotalAmount}/${o.totalAmount}`).join('; ')}`,
  })

  // ── 2. impossible states: created orders cancelled + zero payments ──
  const createdOrders = await db.order.findMany({
    where: { id: { in: createdIds } },
    select: { id: true, status: true },
  })
  const notCancelled = createdOrders.filter((o) => o.status !== 'cancelled')
  const paymentsOnTest = await db.payment.findMany({
    where: { orderId: { in: [...createdIds, ...orphanRows.map((o) => o.id)] } },
    select: { id: true, orderId: true, amount: true },
  })
  const orphanDetail = orphanRows.length
    ? ` | ORPHANS: ${orphanRows
        .map((o) => `#${o.id} stuck in status '${o.status}' with zero totals — create answered 500 AFTER the transaction committed`)
        .join('; ')}`
    : ''
  checks.push({
    id: 2,
    name: 'created test orders all cancelled, zero payments on them',
    pass: notCancelled.length === 0 && paymentsOnTest.length === 0,
    detail:
      `recorded: ${createdOrders.length}/${createdIds.length} cancelled (${notCancelled.length} not cancelled); payments on test orders: ${paymentsOnTest.length}${orphanDetail}`,
  })

  // ── 3. orderItems of created orders exist, quantity > 0 ─────────
  const items = await db.orderItem.findMany({
    where: { orderId: { in: createdIds } },
    select: { orderId: true, quantity: true, unitPrice: true, course: true },
  })
  const itemsByOrder = new Map<number, typeof items>()
  for (const it of items) {
    const arr = itemsByOrder.get(it.orderId) ?? []
    arr.push(it)
    itemsByOrder.set(it.orderId, arr)
  }
  const badItems = createdIds.filter((id) => {
    const arr = itemsByOrder.get(id)
    return !arr || arr.length === 0 || arr.some((i) => !(i.quantity > 0))
  })
  checks.push({
    id: 3,
    name: 'orderItems exist on every created order with quantity > 0',
    pass: badItems.length === 0,
    detail: badItems.length === 0
      ? `${items.length} item rows across ${createdIds.length} orders — all quantity > 0`
      : `orders with missing/zero items: ${badItems.join(', ')}`,
  })

  // ── 4. no pre-existing order lost ───────────────────────────────
  const preExisting = await db.order.count({ where: { id: { lte: baseline.maxOrderId ?? 0 } } })
  checks.push({
    id: 4,
    name: `pre-existing orders intact (count id <= ${baseline.maxOrderId} == baseline ${baseline.orderCount})`,
    pass: preExisting === baseline.orderCount,
    detail: `found ${preExisting} of ${baseline.orderCount}${preExisting === baseline.orderCount ? ' — nothing lost' : ' — LOSS DETECTED'}`,
  })

  // ── 5. hybrid outbox health ─────────────────────────────────────
  const groups = await db.hybridEvent.groupBy({ by: ['direction', 'status'], _count: { _all: true } })
  const grouped = groups.map((g) => ({ direction: g.direction, status: g.status, count: g._count._all })).sort((a, b) => a.direction.localeCompare(b.direction) || a.status.localeCompare(b.status))
  const deadOut = grouped.filter((g) => g.direction === 'out' && g.status === 'dead').reduce((a, g) => a + g.count, 0)
  const baselineStr = JSON.stringify([...baseline.hybridEvents].sort((a, b) => a.direction.localeCompare(b.direction) || a.status.localeCompare(b.status)))
  checks.push({
    id: 5,
    name: `hybrid outbox: no NEW dead events (baseline dead-out = ${baseline.deadOutEvents})`,
    pass: deadOut === baseline.deadOutEvents,
    detail: `after: ${JSON.stringify(grouped)} | baseline was ${baselineStr} | dead-out now ${deadOut}`,
  })

  // ── 6. money math on the created-then-cancelled orders ──────────
  const sampleIds = createdIds.slice(0, 3)
  const moneyRows = await db.order.findMany({
    where: { id: { in: sampleIds } },
    include: { items: { select: { quantity: true, unitPrice: true } } },
  })
  const moneyResults: string[] = []
  let moneyPass = true
  for (const o of moneyRows) {
    const itemsSum = round2(o.items.reduce((a, i) => a + i.quantity * i.unitPrice, 0))
    const net = o.subtotalAmount - o.discountAmount
    const expectedVat = round2(net * TAX_RATE)
    const expectedService = round2(net * SERVICE_TAX_RATE)
    const expectedTotal = round2(o.subtotalAmount - o.discountAmount + expectedVat + expectedService)
    const ok =
      Math.abs(itemsSum - o.subtotalAmount) < MONEY_EPSILON &&
      Math.abs(expectedVat - o.taxAmount) < MONEY_EPSILON &&
      Math.abs(expectedService - o.serviceTaxAmount) < MONEY_EPSILON &&
      Math.abs(expectedTotal - o.totalAmount) < MONEY_EPSILON
    if (!ok) moneyPass = false
    moneyResults.push(
      `#${o.id}: items Σ=${itemsSum} vs subtotal=${o.subtotalAmount}, vat ${o.taxAmount}(exp ${expectedVat}), svc ${o.serviceTaxAmount}(exp ${expectedService}), total ${o.totalAmount}(exp ${expectedTotal}) → ${ok ? 'OK' : 'BROKEN'}`,
    )
  }
  checks.push({
    id: 6,
    name: `money math on created-then-cancelled orders (${sampleIds.join(', ')})`,
    pass: moneyPass && moneyRows.length === sampleIds.length,
    detail: moneyResults.join(' | '),
  })

  // ── 7. dev server still answers on / ────────────────────────────
  let homeStatus = 0
  try {
    const res = await fetch(`${BASE}/`)
    homeStatus = res.status
  } catch {}
  checks.push({
    id: 7,
    name: 'GET / still answers 200',
    pass: homeStatus === 200,
    detail: `HTTP ${homeStatus}`,
  })

  // ── report ──────────────────────────────────────────────────────
  console.log('================ R31 INTEGRITY VERIFICATION ================')
  for (const c of checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  check ${c.id}: ${c.name}\n      ${c.detail}`)
  const allPass = checks.every((c) => c.pass)
  const cancelledAfter = await db.order.count({ where: { status: 'cancelled' } })
  const summary = {
    at: new Date().toISOString(),
    allPass,
    checks,
    baseline,
    createdIds,
    orderCountAfter: afterCount,
    cancelledBefore: baseline.cancelledCount,
    cancelledAfter,
    orphanOrderIds: orphanRows.map((o) => o.id),
    hybridOutboxAfter: grouped,
  }
  writeFileSync('/tmp/r31-integrity-result.json', JSON.stringify(summary, null, 2))
  console.log(`\norders: ${baseline.orderCount} → ${afterCount} (recorded created ${createdIds.length}, orphans ${orphanRows.length})`)
  console.log(`cancelled: ${baseline.cancelledCount} → ${cancelledAfter}`)
  console.log(allPass ? 'ALL 7 CHECKS PASS' : 'SOME CHECKS FAILED — see above')
  await db.$disconnect()
  process.exitCode = allPass ? 0 : 2
}

main().catch((e) => {
  console.error('INTEGRITY SCRIPT FAILURE:', e)
  process.exit(1)
})
