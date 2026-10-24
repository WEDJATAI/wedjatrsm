/**
 * r33 repair addendum — products 226-229 (Lelo menu) could not re-apply from
 * their original Neon events: those events are THIS terminal's own echoes
 * (eventId already in the local out-history → 'duplicate'), and their revs
 * tie/lose against the local event history ('stale-revision') even though
 * the ROWS are missing locally (lost to a recycle — same class as the p20
 * order-1210 loss).
 *
 * Fix: for each product take the NEWEST Neon event payload (current cloud
 * state), mint a FRESH eventId, and ingest at localMaxRev+1 — the designed
 * cloud-authoritative path then upserts the row.
 */
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { db } from '../src/lib/db'
import { ingestRemoteEvent, type RemoteEvent } from '../src/lib/hybrid-sync/apply-remote-event'

function neonUrl(): string {
  const vault = readFileSync('/home/z/my-project/.git/env-vault.env', 'utf8')
  return vault.match(/^NEON_DATABASE_URL=(.+)$/m)![1].trim().replace(/^["']|["']$/g, '')
}

async function main() {
  const pool = new pg.Pool({ connectionString: neonUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
  for (const pid of [226, 227, 228, 229]) {
    const row = await db.product.findUnique({ where: { id: pid }, select: { id: true } })
    if (row) { console.log(`  product ${pid}: already local — skip`); continue }
    const ev = await pool.query(
      `SELECT * FROM hybrid_events WHERE entity='Product' AND "entityId"=$1 ORDER BY revision DESC, id DESC LIMIT 1`,
      [String(pid)],
    )
    if (!ev.rows.length) { console.log(`  product ${pid}: no Neon event — skip (investigate)`); continue }
    const latest = ev.rows[0]
    const maxLocal = await db.hybridEvent.findFirst({
      where: { entity: 'Product', entityId: pid },
      orderBy: [{ revision: 'desc' }, { id: 'desc' }],
      select: { revision: true },
    })
    const nextRev = (maxLocal?.revision ?? 0) + 1
    const evt: RemoteEvent = {
      eventId: crypto.randomUUID(),
      deviceId: String(latest.deviceId),
      entity: 'Product',
      entityId: pid,
      operation: 'update',
      revision: nextRev,
      payloadHash: `r33-recover-${pid}-${nextRev}`,
      payload: JSON.parse(String(latest.payload)) as Record<string, unknown>,
    }
    const out = await ingestRemoteEvent(evt)
    const p = await db.product.findUnique({ where: { id: pid }, select: { name: true, price: true, active: true } })
    console.log(`  product ${pid}: ingest rev${nextRev} → ${out.outcome}${out.reason ? ` (${out.reason})` : ''} → ${p ? `${p.name} EGP ${p.price} active=${p.active}` : 'STILL MISSING'}`)
  }
  console.log(`  local products now: ${await db.product.count()} (expect 303)`)
  await pool.end()
  await db.$disconnect()
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
