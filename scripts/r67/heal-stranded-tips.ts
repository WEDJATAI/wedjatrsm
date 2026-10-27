/**
 * r67: one-off repair — converge the TIP values that the append-only policy
 * stranded on one plane.
 *
 * Background: a gratuity recorded through /api/orders/[id]/tip updates the
 * payment row's `tip` and emits a Payment UPDATE event — which the
 * append-only policy REJECTED on every other plane ('update-on-payments'
 * conflicts). The r67 policy fix (isPaymentTipUpdate) lets tip-only growth
 * propagate going forward; THIS script heals the two known divergent rows
 * (live evidence at fix time):
 *
 *   payment #299 (order #2231): local 95.45 → cloud 190.90 (tip added on cloud)
 *   payment #319 (order #2245): local  0.00 → cloud 160.00 (tip added on cloud)
 *
 * The heal writes the authoritative (cloud) value locally and emits the
 * Payment update outbox event in the same transaction. On the cloud the
 * event is a same-content no-op (it already has the value); on the desktop
 * it lands with the r67 policy (new payload) or on the next bootstrap
 * refresh.
 *
 *   bun scripts/r67/heal-stranded-tips.ts           # apply
 *   bun scripts/r67/heal-stranded-tips.ts --dry-run # report only
 */
import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'

const db = new PrismaClient({
  adapter: new PrismaLibSql({ url: (process.env.DATABASE_URL ?? 'file:./db/custom.db').split('?')[0] }),
}) // r49: Prisma 7 adapter

/** authoritative tip values verified against the Neon cloud plane */
const AUTHORITATIVE: Array<{ paymentId: number; tip: number; note: string }> = [
  { paymentId: 299, tip: 190.9, note: 'order #2231 — tip recorded on the cloud plane (local kept 95.45)' },
  { paymentId: 319, tip: 160, note: 'order #2245 — tip recorded on the cloud plane (local kept 0)' },
]

async function main() {
  const dryRun = process.argv.includes('--dry-run')
  for (const entry of AUTHORITATIVE) {
    const payment = await db.payment.findUnique({
      where: { id: entry.paymentId },
    })
    if (!payment) {
      console.log(`  #${entry.paymentId}: not found on this plane — skipped`)
      continue
    }
    if (payment.tip != null && payment.tip >= entry.tip) {
      console.log(`  #${entry.paymentId}: already ${payment.tip.toFixed(2)} ≥ ${entry.tip.toFixed(2)} — nothing to do`)
      continue
    }
    if (dryRun) {
      console.log(`  #${entry.paymentId}: would raise tip ${(payment.tip ?? 0).toFixed(2)} → ${entry.tip.toFixed(2)} (${entry.note})`)
      continue
    }
    await db.$transaction(async (tx) => {
      const row = await tx.payment.update({
        where: { id: entry.paymentId },
        data: { tip: entry.tip },
      })
      const { emitOutboxEvent } = await import('../../src/lib/hybrid-sync/outbox')
      await emitOutboxEvent(tx, {
        entity: 'Payment',
        entityId: row.id,
        operation: 'update',
        row,
      })
    })
    console.log(`  #${entry.paymentId}: tip raised ${(payment.tip ?? 0).toFixed(2)} → ${entry.tip.toFixed(2)} + outbox event (${entry.note})`)
  }
  console.log('[r67-tip-heal] done')
}

main()
  .catch((err) => {
    console.error('[r67-tip-heal] FAILED:', err)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
