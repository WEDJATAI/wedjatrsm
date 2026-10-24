/**
 * r31 COO audit — data repair pass.
 * 1. Cancel 16 stale/zombie open takeaway orders (load-test artifacts from
 *    Sept-28 + today's stress zombies #335-337) via the DESIGNED channel
 *    (POST /api/orders/{id}/cancel) so audit + outbox + Neon sync all ride.
 * 2. Order #40 (table 1): recompute authoritative totals (items outgrew the
 *    stored check — 225 stored vs 485 in items).
 * 3. Order #87: normalize legacy orderType takeaway→dinein (it occupies
 *    table 2; the create-time guard forbidding this is newer than the row).
 * Untouched BY DESIGN: 22 paid orders without payment rows (historical
 * artifact, documented — never fabricate tender data), order #70 double
 * payment (documented p8 race artifact).
 */
import { readFileSync } from 'node:fs'
import { db } from '../src/lib/db'
import { recomputeTotals } from '../src/lib/orders'
import { emitOutboxEvent } from '../src/lib/hybrid-sync/outbox'

const TOKEN = readFileSync('/tmp/rsm-tok-manager-login.txt', 'utf8').trim()
const BASE = 'http://127.0.0.1:3000'

async function cancelOrder(id: number, reason: string): Promise<string> {
  const res = await fetch(`${BASE}/api/orders/${id}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  })
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  return res.ok ? 'ok' : `FAIL ${res.status}: ${body.error ?? ''}`
}

async function main() {
  const stale = [42, 45, 46, 49, 50, 55, 56, 57, 59, 63, 67, 73, 81]
  const zombies = [335, 336, 337]
  console.log('=== 1. cancel stale load-test orders ===')
  for (const id of stale) console.log(`  #${id}:`, await cancelOrder(id, 'r31 audit: stale open takeaway from Sept-28 load test (5 days old, never completed)'))
  console.log('=== 2. cancel zombie zero-total orders ===')
  for (const id of zombies) console.log(`  #${id}:`, await cancelOrder(id, 'r31 audit: zombie order from pre-fix create race (total=0, root cause fixed this round)'))
  console.log('=== 3. recompute order #40 (table 1) ===')
  const before = await db.order.findUnique({ where: { id: 40 }, select: { subtotalAmount: true, totalAmount: true } })
  const after = await recomputeTotals(40)
  console.log(`  before: sub ${before?.subtotalAmount} total ${before?.totalAmount} → after: sub ${after.subtotalAmount} total ${after.totalAmount}`)
  console.log('=== 4. normalize order #87 orderType takeaway→dinein ===')
  const updated87 = await db.$transaction(async (tx) => {
    const row = await tx.order.update({ where: { id: 87 }, data: { orderType: 'dinein' } })
    await emitOutboxEvent(tx, { entity: 'Order', entityId: 87, operation: 'update', row })
    return row
  })
  console.log(`  #87 orderType → ${updated87.orderType} (table ${updated87.tableId} stays occupied)`)
  console.log('=== 5. post-repair verification ===')
  const badOpen = await db.order.findMany({ where: { status: 'open', totalAmount: 0 }, select: { id: true } })
  console.log('  open orders with total=0:', badOpen.length, badOpen.map(o => o.id))
  const staleOpen = await db.order.count({ where: { status: 'open', tableId: null, createdAt: { lt: new Date('2026-10-01') } } })
  console.log('  stale open takeaways remaining:', staleOpen)
  const o40 = await db.order.findUnique({ where: { id: 40 }, select: { subtotalAmount: true, totalAmount: true, status: true } })
  console.log('  order #40 now:', JSON.stringify(o40))
  const openCount = await db.order.count({ where: { status: 'open' } })
  console.log('  total open orders now:', openCount)
}
main().catch(e => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
