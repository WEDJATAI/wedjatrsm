/**
 * r33: pull the 13 late-September banquet payments (orders 312-326) from
 * Neon to local. They exist ONLY on Neon (paid on prod, pre-dating the
 * reliable pull era). Their Neon ids collide with local's September
 * split-payment demos → remap to fresh local ids (220+), ingest through
 * the designed append-only channel. The id map is documented in worklog.
 */
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { db } from '../src/lib/db'
import { ingestRemoteEvent, type RemoteEvent } from '../src/lib/hybrid-sync/apply-remote-event'

function neonUrl(): string {
  const vault = readFileSync('/home/z/my-project/.git/env-vault.env', 'utf8')
  return vault.match(/^NEON_DATABASE_URL=(.+)$/m)![1].trim().replace(/^["']|["']$/g, '')
}


/** snake_case raw PG row → camelCase Prisma payload (event wire format). */
function toCamel(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    const ck = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
    if (v instanceof Date) out[ck] = v.toISOString()
    else if (v !== null && v !== undefined) out[ck] = v
  }
  return out
}

const ORDERS = [312, 314, 316, 317, 318, 319, 320, 321, 322, 323, 324, 325, 326]

async function main() {
  const pool = new pg.Pool({ connectionString: neonUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
  let nextId = 220
  const idMap: string[] = []
  for (const oid of ORDERS) {
    const rows = await pool.query(`SELECT * FROM payments WHERE order_id = $1 ORDER BY id`, [oid])
    if (!rows.rows.length) { console.log(`order ${oid}: no Neon payments (investigate)`); continue }
    for (const r of rows.rows) {
      const local = await db.payment.findMany({ where: { orderId: oid }, select: { id: true, amount: true } })
      if (local.some(p => Math.abs(p.amount - Number(r.amount)) < 0.02)) {
        console.log(`order ${oid}: payment ${r.amount} already local (${local.map(p => p.id + ':' + p.amount).join(',')}) — skip`)
        continue
      }
      const payload = { ...toCamel(r as Record<string, unknown>), id: nextId }
      const evt: RemoteEvent = {
        eventId: crypto.randomUUID(), deviceId: 'neon-banquet-recover',
        entity: 'Payment', entityId: nextId, operation: 'create', revision: 1,
        payloadHash: `r33-banquet-${nextId}`, payload: payload as Record<string, unknown>,
      }
      const out = await ingestRemoteEvent(evt)
      const chk = await db.payment.findUnique({ where: { id: nextId }, select: { orderId: true, amount: true } })
      console.log(`Neon pay#${r.id} (order ${oid}, ${r.amount}) → local id ${nextId}: ${out.outcome}${out.reason ? ` (${out.reason})` : ''} ${chk ? '✓ ' + chk.amount : 'MISSING'}`)
      idMap.push(`${nextId}=neon#${r.id}(o${oid})`)
      nextId++
    }
  }
  console.log('ID MAP:', idMap.join(' '))
  console.log('local payments now:', await db.payment.count())
  await pool.end()
  await db.$disconnect()
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
