/**
 * p21: HEAL THE CLOUD-SIDE FAILED IN-EVENTS.
 *
 * Today's p21 seed pushed ingredient/recipe events while Neon was missing
 * category 6 (the FK parent) — the first attempt failed, and the RETRY was
 * acked as a "duplicate no-op" (the p21 ingestRemoteEvent bug, now fixed).
 * Result: locally acked, cloud-side 'failed' — stranded.
 *
 * This script cross-references Neon's failed in-events against the local
 * outbox, resets the matching local events back to 'pending' and lets the
 * engine re-push them — with the ingest fix, the cloud now RETRIES the
 * failed in-record instead of acking it as a duplicate, and the parents
 * (category 6, all ingredient products) exist by then.
 *
 * Run: bun scripts/p21-heal-cloud.ts   (then drain with sync-now cycles)
 */
import { db } from '../src/lib/db'
import { PrismaClient as PgClient } from '../pgtmp-client'
import { PrismaPg } from '@prisma/adapter-pg'
import { neonPooledUrl } from './lib/env-local'

async function main() {
  const pg = new PgClient({ adapter: new PrismaPg({ connectionString: neonPooledUrl() }) })
  try {
    const failed = await pg.$queryRawUnsafe(
      `SELECT "eventId" FROM hybrid_events WHERE direction='in' AND status='failed' AND "createdAt" > '2026-10-03'`,
    ) as Array<{ eventId: string }>
    console.log(`cloud-side failed in-events (today): ${failed.length}`)

    let matched = 0
    let unmatched = 0
    const unmatchedIds: string[] = []
    for (const row of failed) {
      const local = await db.hybridEvent.findUnique({ where: { eventId: row.eventId } })
      if (!local || local.direction !== 'out') {
        unmatched++
        if (unmatchedIds.length < 5) unmatchedIds.push(row.eventId)
        continue
      }
      if (local.status === 'acked') {
        await db.hybridEvent.update({
          where: { id: local.id },
          data: { status: 'pending', nextAttemptAt: new Date(), attempts: 0, lastError: null, ackedAt: null },
        })
        matched++
      } else {
        matched++ // already pending/inflight — will re-push anyway
      }
    }
    console.log(`local out-events matched+reset: ${matched} · unmatched cloud-only: ${unmatched}`)
    if (unmatchedIds.length > 0) console.log('sample unmatched:', unmatchedIds.join(', '))
    const pending = await db.hybridEvent.count({ where: { direction: 'out', status: 'pending' } })
    console.log(`local outbox now: ${pending} pending — drain with sync-now cycles`)
  } finally {
    await pg.$disconnect()
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
