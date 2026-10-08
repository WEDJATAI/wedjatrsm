// p18b-close-modifier-gap: close the last local→Neon sync gap found in the
// post-p18 parity sweep — Modifier id 24 "Olive oil" (Salad Dressing group,
// used by Caesar Salad). The row predates the hybrid outbox (legacy seed) so
// it never had an out event; every other modifier made it to the cloud.
//
// Approach: re-emit a 'create' outbox event for the EXISTING local row via
// the engine's own emitOutboxEvent (same canonicalJson + payloadHash + next
// revision), then run ONE push cycle through the engine's runPushCycle so the
// event rides the normal HTTPS outbox channel to the cloud (/api/hybrid/push
// on the target from AppSetting sync.targetUrl). No direct DB writes to Neon.
//
// Usage: bun scripts/p18b-close-modifier-gap.ts
import { db } from '@/lib/db'
import { emitOutboxEvent } from '@/lib/hybrid-sync/outbox'
import { runPushCycle } from '@/lib/hybrid-sync/push'

const ENTITY = 'Modifier'
const ID = 24

async function main() {
  const row = await db.modifier.findUnique({ where: { id: ID } })
  if (!row) throw new Error(`modifier ${ID} not found locally`)
  console.log(`local modifier ${ID}:`, JSON.stringify(row))

  // Idempotency guard: never enqueue a second backfill event.
  const existing = await db.hybridEvent.findMany({
    where: { entity: ENTITY, entityId: ID, direction: 'out' },
    select: { id: true, status: true },
  })
  if (existing.length > 0) {
    console.log(`out events already present for ${ENTITY}/${ID}:`, JSON.stringify(existing))
  } else {
    await db.$transaction(async (tx) => {
      await emitOutboxEvent(tx, { entity: ENTITY, entityId: ID, operation: 'create', row: row as unknown as Record<string, unknown> })
    })
    console.log(`outbox event emitted for ${ENTITY}/${ID} (op=create)`)
  }

  const result = await runPushCycle()
  console.log('push cycle:', JSON.stringify(result))
  if (result.error) process.exitCode = 1
  await db.$disconnect()
}

main().catch((err) => {
  console.error('FAILED:', err)
  process.exit(1)
})
