/**
 * p20 touch-repair — the 6 final-gate orders damaged on the CLOUD by the
 * out-of-order batch race (#590, #591, #592, #593, #604, #605): their rev-1
 * create payloads landed on Neon AFTER the rev-3 cancel payloads and
 * re-opened them (the origin-authority policy had no revision floor — fixed
 * this round in apply-remote-event.ts; the engine cycles are also serialized
 * now so the race cannot recur).
 *
 * Repair through the DESIGNED channel: re-emit each order's current
 * (cancelled) row as a fresh outbox event (rev = max+1) in the same
 * transaction as a no-op touch — the push cycle delivers it, the cloud's
 * origin guard passes (we are the origin device), and the row converges to
 * cancelled. No raw cloud writes.
 */
import { db } from '../src/lib/db'
import { emitOutboxEvent } from '../src/lib/hybrid-sync/outbox'

const DAMAGED = [590, 591, 592, 593, 604, 605]

async function main() {
  console.log('=== touch-repair', DAMAGED.join(', '), '===')
  for (const id of DAMAGED) {
    const local = await db.order.findUnique({ where: { id }, select: { id: true, status: true, totalAmount: true } })
    if (!local) { console.log(`  #${id}: NOT FOUND locally — skipping`); continue }
    if (local.status !== 'cancelled') { console.log(`  #${id}: local status is ${local.status}, not cancelled — skipping (investigate)`); continue }
    const row = await db.$transaction(async (tx) => {
      const updated = await tx.order.update({ where: { id }, data: { updatedAt: new Date() } })
      await emitOutboxEvent(tx, { entity: 'Order', entityId: id, operation: 'update', row: updated })
      return updated
    })
    console.log(`  #${id}: re-emitted rev+1 (status=${row.status}, total=${row.totalAmount})`)
  }
  const pend = await db.hybridEvent.count({ where: { direction: 'out', status: 'pending' } })
  console.log(`outbox pending now: ${pend} (engine pushes within 30s; run sync-now to accelerate)`)
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
