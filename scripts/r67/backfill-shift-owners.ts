/**
 * r67: one-off repair — attribute the ORPHANED closed checks to the server
 * who closed them, so "My shift" shows them.
 *
 * Background: orders born from the Mazaj hookah integration webhook carry
 * user_id NULL (no session exists at webhook time). The waiters who later
 * presented and paid those checks (visible in the audit trail) never got
 * them counted in their shift. The r67 route fixes stamp the acting user
 * at first touch going forward; THIS script repairs the history:
 *
 *   for every PAID order with user_id NULL → read the order.payment audit
 *   row → stamp that user as the order owner, PRESERVING updated_at (so an
 *   old check does not artificially appear as "closed today"), and emit the
 *   Order-update outbox event in the same transaction (revision-aware) so
 *   Neon and the desktop converge on the repair.
 *
 * Open/merged userless orders are left alone: nobody has closed them yet —
 * the r67 payment-time claim handles them the moment they are settled.
 *
 *   bun scripts/r67/backfill-shift-owners.ts           # apply
 *   bun scripts/r67/backfill-shift-owners.ts --dry-run # report only
 */
import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'

const db = new PrismaClient({
  adapter: new PrismaLibSql({ url: (process.env.DATABASE_URL ?? 'file:./db/custom.db').split('?')[0] }),
}) // r49: Prisma 7 adapter

async function main() {
  const dryRun = process.argv.includes('--dry-run')

  const orphans = await db.order.findMany({
    where: { userId: null, status: 'paid' },
    select: { id: true, updatedAt: true, totalAmount: true },
    orderBy: { id: 'asc' },
  })
  if (orphans.length === 0) {
    console.log('[r67-backfill] no orphaned paid checks — nothing to do')
    return
  }
  console.log(`[r67-backfill] ${orphans.length} orphaned paid check(s):`, orphans.map((o) => o.id).join(', '))

  for (const order of orphans) {
    // who closed it? the LAST order.payment audit row on this order
    const closer = await db.auditLog.findFirst({
      where: { entity: 'order', entityId: order.id, action: 'order.payment' },
      orderBy: { id: 'desc' },
      select: { userId: true, userName: true },
    })
    if (!closer || closer.userId == null) {
      console.log(`  #${order.id}: no payment audit user — skipped (stays unattributed)`)
      continue
    }
    if (dryRun) {
      console.log(`  #${order.id}: would claim for ${closer.userName} (#${closer.userId}) — EGP ${order.totalAmount.toFixed(2)}`)
      continue
    }
    await db.$transaction(async (tx) => {
      // explicit updatedAt → PRESERVE the original close timestamp (Prisma
      // allows overriding @updatedAt with a provided value)
      const row = await tx.order.update({
        where: { id: order.id },
        data: { userId: closer.userId, updatedAt: order.updatedAt },
      })
      const { emitOutboxEvent } = await import('../../src/lib/hybrid-sync/outbox')
      await emitOutboxEvent(tx, {
        entity: 'Order',
        entityId: order.id,
        operation: 'update',
        row,
      })
    })
    console.log(`  #${order.id}: claimed for ${closer.userName} (#${closer.userId}) — EGP ${order.totalAmount.toFixed(2)} + outbox event`)
  }
  console.log('[r67-backfill] done')
}

main()
  .catch((err) => {
    console.error('[r67-backfill] FAILED:', err)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
