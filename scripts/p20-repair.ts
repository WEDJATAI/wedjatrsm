/**
 * p20 harmony repair — closes the three real divergences found after
 * recycle #9 (all through DESIGNED channels; every write audit-logged or
 * event-recorded; zero raw business-row surgery):
 *
 * 1. CANCEL 26 stress-residue open takeaways (#342-#378, created Oct 2 by the
 *    OOM-interrupted r31 fix-verification runs; zero payments, Arabita-110
 *    pattern, origin-stamped by THIS device so the cancel is authoritative)
 *    via POST /api/orders/{id}/cancel → outbox events ride to Neon.
 *
 * 2. RELEASE 50 outbox events stuck 'inflight' since the Oct 2 OOM (claimed by
 *    a dead process mid-push, never settled; the claim query only picks
 *    'pending' so they were orphaned forever) back to 'pending' — the push
 *    protocol is idempotent (eventId dedupe on the cloud), so re-delivery is
 *    safe.
 *
 * 3. RECOVER order #1210 + payment #208 (a REAL paid takeaway, Meena's
 *    account, cash EGP 54.18 exact change, created on the PRE-recycle local
 *    terminal Oct 2 12:25:57 and pushed to Neon; the recycle restored an
 *    earlier recovery point so the local lost it, and the pull can never
 *    bring it back — those events are the local's OWN echoes, excluded by the
 *    deviceId filter). We fetch the 6 events from Neon and feed each through
 *    ingestRemoteEvent — the same policy engine the pull cycle uses.
 */
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { db } from '../src/lib/db'
import { ingestRemoteEvent, type RemoteEvent } from '../src/lib/hybrid-sync/apply-remote-event'

const BASE = 'http://127.0.0.1:3000'

// ── helpers ───────────────────────────────────────────────────────────
async function mintToken(): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/manager-login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: '123456' }),
  })
  if (!res.ok) throw new Error(`manager-login HTTP ${res.status}`)
  const body = (await res.json()) as { token: string }
  return body.token
}

async function cancelOrder(id: number, token: string, reason: string): Promise<string> {
  const res = await fetch(`${BASE}/api/orders/${id}/cancel`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  })
  const body = (await res.json().catch(() => ({}))) as { error?: string }
  return res.ok ? 'ok' : `FAIL ${res.status}: ${body.error ?? ''}`
}

function neonUrl(): string {
  const vault = readFileSync('/home/z/my-project/.git/env-vault.env', 'utf8')
  return vault.match(/^NEON_DATABASE_URL=(.+)$/m)![1].trim().replace(/^["']|["']$/g, '')
}

// ── main ──────────────────────────────────────────────────────────────
async function main() {
  console.log('=== 1. cancel 26 stress-residue orders (#342-#378) ===')
  const token = await mintToken()
  const residue = [342, 343, 346, 349, 350, 351, 352, 360, 361, 362, 363, 364, 365, 366, 367, 368, 369, 370, 371, 372, 373, 374, 375, 376, 377, 378]
  // safety preflight: every one of them must be open, takeaway, zero payments
  const preflight = await db.order.findMany({
    where: { id: { in: residue } },
    select: { id: true, status: true, orderType: true, _count: { select: { payments: true } } },
  })
  const unsafe = preflight.filter((o) => o.status !== 'open' || o.orderType !== 'takeaway' || o._count.payments > 0)
  if (unsafe.length > 0) {
    console.log('  PREFLIGHT FAIL — these rows do not match the stress-residue signature:', JSON.stringify(unsafe))
    console.log('  ABORTING cancels (nothing written).')
  } else {
    console.log(`  preflight ok: ${preflight.length}/26 open takeaways with zero payments`)
    for (const id of residue) {
      console.log(`  #${id}:`, await cancelOrder(id, token, 'p20 harmony repair: stress-test residue from Oct-2 OOM-interrupted runs (never tendered, cancelled to converge local+cloud)'))
    }
  }

  console.log('=== 2. release 50 stuck-inflight outbox events ===')
  const inflight = await db.hybridEvent.findMany({
    where: { direction: 'out', status: 'inflight' },
    select: { id: true },
  })
  console.log(`  stuck inflight: ${inflight.length}`)
  if (inflight.length > 0) {
    const rel = await db.hybridEvent.updateMany({
      where: { direction: 'out', status: 'inflight' },
      data: { status: 'pending', nextAttemptAt: null, batchId: null },
    })
    console.log(`  released to pending: ${rel.count} (attempts kept — budget is 20; cloud dedupes by eventId)`)
  }

  console.log('=== 3. recover order #1210 + payment #208 (own-echo events, direct ingest) ===')
  const client = new pg.Client({ connectionString: neonUrl(), ssl: { rejectUnauthorized: false } })
  await client.connect()
  const { rows } = await client.query(
    `select id, "eventId", "deviceId", entity, "entityId", operation, revision, "payloadHash", payload
     from hybrid_events
     where (entity = 'Order' and "entityId" = 1210)
        or (entity = 'OrderItem' and "entityId" = 1210)
        or (entity = 'Payment' and "entityId" = 208)
     order by id`,
  )
  await client.end()
  console.log(`  fetched ${rows.length} events from Neon`)
  // dependency order: the Order row must exist before its item (FK), payment last
  const rank = (e: { entity: string; operation: string }) =>
    e.entity === 'Order' && e.operation === 'create' ? 0
      : e.entity === 'Order' ? 1
        : e.entity === 'OrderItem' ? 2
          : 3
  rows.sort((a, b) => rank(a) - rank(b))
  for (const r of rows) {
    const evt: RemoteEvent = {
      eventId: String(r.eventId),
      deviceId: String(r.deviceId),
      entity: String(r.entity),
      entityId: Number(r.entityId),
      operation: String(r.operation),
      revision: Number(r.revision),
      payloadHash: String(r.payloadHash),
      payload: JSON.parse(r.payload) as Record<string, unknown>,
    }
    const out = await ingestRemoteEvent(evt)
    console.log(`  evt cloud#${r.id} ${r.entity}/${r.entityId} ${r.operation} rev=${r.revision} → ${out.outcome}${out.reason ? ` (${out.reason})` : ''}${out.resolution ? ` [${out.resolution}]` : ''}`)
  }

  console.log('=== 4. post-repair verification ===')
  const o1210 = await db.order.findUnique({ where: { id: 1210 }, select: { id: true, status: true, totalAmount: true, orderType: true } })
  console.log('  order #1210 locally:', JSON.stringify(o1210))
  const p208 = await db.payment.findUnique({ where: { id: 208 }, select: { id: true, orderId: true, method: true, amount: true } })
  console.log('  payment #208 locally:', JSON.stringify(p208))
  const stillOpen = await db.order.findMany({ where: { id: { in: residue }, status: 'open' }, select: { id: true } })
  console.log('  residue still open (should be 0):', stillOpen.length)
  const openNow = await db.order.count({ where: { status: 'open' } })
  console.log('  total open orders now:', openNow, '(expect 10 dine-in + 0 residue + 1210 recovered as paid)')
  const pend = await db.hybridEvent.count({ where: { direction: 'out', status: 'pending' } })
  const infl = await db.hybridEvent.count({ where: { direction: 'out', status: 'inflight' } })
  console.log(`  outbox: pending=${pend} inflight=${infl} (engine drains pending automatically)`)
}
main().catch((e) => { console.error(e); process.exit(1) }).finally(() => db.$disconnect())
