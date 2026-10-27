/**
 * r68 — heal the cross-plane stuck checks ON THE CLOUD PLANE (Neon).
 *
 * Why this exists: the local heal's outbox events reached the cloud at 14:05,
 * BEFORE the r68 code deployed there (14:20) — the cloud (still r67) rejected
 * the close updates with the same origin-authority guard, so Neon keeps its
 * own stuck copies of #2235/#2243/#2248/#2249/#2251 and never received the
 * settle-claim. NOW the cloud runs the r68 guard, so this script drives the
 * heal through the cloud's OWN production ingest path:
 *
 *   1. discover Neon's stuck checks (open/deferred + full payments) via the
 *      pg client (the p21 pattern — the project's generated client is SQLite)
 *   2. for each, take the authoritative terminal payload from Neon's own
 *      hybrid_events log and POST a fresh heal event (rev = neonMax+1) to
 *      PROD /api/hybrid/push with the local terminal's device credentials —
 *      the deployed r68 guard applies it on Neon
 *   3. for #2251-style old checks (paid, closed on a later day than created,
 *      audit-proven closer ≠ owner) push the settle-claim row as one more
 *      event so the cloud's My shift attribution converges too
 *
 * Run: bun scripts/r68/heal-stuck-checks-cloud.ts
 */
import { PrismaClient as PgClient } from '../../pgtmp-client'
import { PrismaPg } from '@prisma/adapter-pg'
import { randomUUID } from 'node:crypto'

import { canonicalJson, sha256Hex } from '../../src/lib/hybrid-sync/serialization'
import { neonPooledUrl } from '../lib/env-local'

const TERMINAL = new Set(['paid', 'cancelled', 'merged'])
const CLOUD = process.env.R68_CLOUD_URL ?? 'https://wedjatrsm.vercel.app'
const DEVICE_ID = process.env.R68_DEVICE_ID ?? '4680bc22-da4f-46f6-a527-db1db603e0a6'
const DEVICE_KEY =
  process.env.R68_DEVICE_KEY ?? '65b0ece61c6b2e99dfa3fd2830de481bf16151771c5b409be061ea4f913b5ade'

type WireEvent = {
  eventId: string
  deviceId: string
  entity: string
  entityId: number
  operation: 'update'
  revision: number
  payloadHash: string
  payload: Record<string, unknown>
}

async function pushEvents(events: WireEvent[]): Promise<{ acked: string[]; rejected: unknown[]; conflicts: unknown[] }> {
  const res = await fetch(`${CLOUD}/api/hybrid/push`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hybrid-device': DEVICE_ID,
      'x-hybrid-key': DEVICE_KEY,
    },
    body: JSON.stringify({ events }),
    signal: AbortSignal.timeout(60_000),
  })
  const data = (await res.json().catch(() => ({}))) as {
    acked?: string[]
    rejected?: unknown[]
    conflicts?: unknown[]
    error?: string
  }
  if (!res.ok) throw new Error(`push HTTP ${res.status}: ${data.error ?? 'unknown'}`)
  return { acked: data.acked ?? [], rejected: data.rejected ?? [], conflicts: data.conflicts ?? [] }
}

async function main() {
  const pg = new PgClient({ adapter: new PrismaPg({ connectionString: neonPooledUrl() }) })
  try {
    // Discovery: open/deferred checks whose event log carries a TERMINAL
    // payload (the closing plane's authoritative state). This covers BOTH
    // fully-paid-stuck checks AND stale-total rows (Neon's #2251 kept the
    // pre-reduction total 6059.10 while its payments + the authoritative
    // payload say 4847.28 — payment-coverage alone would miss it).
    const openOrders = await pg.order.findMany({
      where: { status: { in: ['open', 'deferred'] } },
      select: {
        id: true, status: true, orderType: true, userId: true, totalAmount: true,
        createdAt: true, payments: { select: { amount: true } },
      },
      orderBy: { id: 'asc' },
    })
    const fullyPaid: typeof openOrders = []
    for (const o of openOrders) {
      const events = await pg.hybridEvent.findMany({
        where: { entity: 'Order', entityId: o.id, direction: 'in' },
        orderBy: [{ revision: 'desc' }, { id: 'desc' }],
        take: 40,
      })
      const hasTerminal = events.some((ev) => {
        try {
          return TERMINAL.has(String((JSON.parse(ev.payload) as Record<string, unknown>).status))
        } catch {
          return false
        }
      })
      if (hasTerminal) fullyPaid.push(o)
    }
    console.log(`CLOUD stuck open/deferred checks with a terminal payload in the log: ${fullyPaid.map((o) => `#${o.id}`).join(', ') || 'none'}`)
    if (fullyPaid.length === 0) {
      console.log('cloud plane already clean — nothing to do')
      return
    }

    const healEvents: WireEvent[] = []
    const meta = new Map<number, { payload: Record<string, unknown>; maxRev: number }>()
    for (const order of fullyPaid) {
      const events = await pg.hybridEvent.findMany({
        where: { entity: 'Order', entityId: order.id, direction: 'in' },
        orderBy: [{ revision: 'desc' }, { id: 'desc' }],
        take: 40,
      })
      const maxRev = events[0]?.revision ?? 0
      let authoritative: Record<string, unknown> | null = null
      let senderDeviceId = DEVICE_ID
      for (const ev of events) {
        try {
          const payload = JSON.parse(ev.payload) as Record<string, unknown>
          if (TERMINAL.has(String(payload.status))) {
            authoritative = payload
            senderDeviceId = ev.deviceId
            break
          }
        } catch {
          /* skip unparseable */
        }
      }
      if (!authoritative) {
        console.log(`  #${order.id}: NO terminal payload in the CLOUD event log — SKIPPED`)
        continue
      }
      meta.set(order.id, { payload: authoritative, maxRev })
      healEvents.push({
        eventId: `r68-heal-${order.id}-${randomUUID().slice(0, 8)}`,
        deviceId: senderDeviceId,
        entity: 'Order',
        entityId: order.id,
        operation: 'update',
        revision: maxRev + 1,
        payloadHash: sha256Hex(canonicalJson(authoritative)),
        payload: authoritative,
      })
    }

    console.log(`pushing ${healEvents.length} heal event(s) through the CLOUD's own ingest path…`)
    const r1 = await pushEvents(healEvents)
    console.log(`  acked: ${r1.acked.length} · rejected: ${r1.rejected.length} · conflicts: ${r1.conflicts.length}`)
    if (r1.rejected.length > 0) console.log('  rejected detail:', JSON.stringify(r1.rejected).slice(0, 300))
    if (r1.conflicts.length > 0) console.log('  conflicts detail:', JSON.stringify(r1.conflicts).slice(0, 300))

    // settle-claims: old checks (created before the close day) paid by a
    // different audit-proven closer → the closer's shift (mirror of the local
    // rule). Push the claimed row as one more event AFTER the heal landed.
    await new Promise((r) => setTimeout(r, 2000))
    const claimEvents: WireEvent[] = []
    for (const order of fullyPaid) {
      const m = meta.get(order.id)
      if (!m || m.payload.status !== 'paid') continue
      const closedAt = m.payload.closedAt
      if (typeof closedAt !== 'string') continue
      const closeDay = new Date(closedAt)
      const createdDay = order.createdAt
      const sameDay =
        closeDay.getFullYear() === createdDay.getFullYear() &&
        closeDay.getMonth() === createdDay.getMonth() &&
        closeDay.getDate() === createdDay.getDate()
      if (sameDay) continue
      const audit = await pg.auditLog.findFirst({
        where: { action: 'order.payment', entityId: order.id },
        orderBy: { id: 'desc' },
        select: { userId: true },
      })
      const ownerUserId = m.payload.userId
      if (audit?.userId == null || audit.userId === ownerUserId) continue
      const claimed = { ...m.payload, userId: audit.userId }
      claimEvents.push({
        eventId: `r68-claim-${order.id}-${randomUUID().slice(0, 8)}`,
        deviceId: DEVICE_ID,
        entity: 'Order',
        entityId: order.id,
        operation: 'update',
        revision: m.maxRev + 2,
        payloadHash: sha256Hex(canonicalJson(claimed)),
        payload: claimed,
      })
      console.log(`  #${order.id}: settle-claim event userId ${String(ownerUserId)} → ${audit.userId}`)
    }
    if (claimEvents.length > 0) {
      const r2 = await pushEvents(claimEvents)
      console.log(`  claim push — acked: ${r2.acked.length} · rejected: ${r2.rejected.length} · conflicts: ${r2.conflicts.length}`)
      if (r2.conflicts.length > 0) console.log('  conflicts detail:', JSON.stringify(r2.conflicts).slice(0, 300))
    }

    // verify the cloud state after the heal
    await new Promise((r) => setTimeout(r, 2000))
    const after = await pg.order.findMany({
      where: { id: { in: fullyPaid.map((o) => o.id) } },
      select: { id: true, status: true, userId: true },
      orderBy: { id: 'asc' },
    })
    for (const o of after) console.log(`  AFTER: #${o.id} status=${o.status} userId=${o.userId}`)
    const stillStuck = after.filter((o) => o.status === 'open' || o.status === 'deferred')
    console.log(stillStuck.length === 0 ? 'CLOUD PLANE CLEAN — all stuck checks healed' : `STILL STUCK ON CLOUD: ${stillStuck.map((o) => o.id).join(', ')}`)
  } finally {
    await pg.$disconnect()
  }
}

main().catch((err) => {
  console.error('heal-stuck-checks-cloud failed:', err)
  process.exit(1)
})
