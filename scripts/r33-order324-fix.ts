/** r33: pull order 324's remaining 10 split payments (Neon ids 105-114). */
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { db } from '../src/lib/db'
import { ingestRemoteEvent, type RemoteEvent } from '../src/lib/hybrid-sync/apply-remote-event'

function neonUrl(): string {
  const vault = readFileSync('/home/z/my-project/.git/env-vault.env', 'utf8')
  return vault.match(/^NEON_DATABASE_URL=(.+)$/m)![1].trim().replace(/^["']|["']$/g, '')
}
function toCamel(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    const ck = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
    if (v instanceof Date) out[ck] = v.toISOString()
    else if (v !== null && v !== undefined) out[ck] = v
  }
  return out
}
async function main() {
  const pool = new pg.Pool({ connectionString: neonUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
  const rows = await pool.query(`SELECT * FROM payments WHERE order_id = 324 AND id BETWEEN 105 AND 114 ORDER BY id`)
  let nextId = 241
  for (const r of rows.rows) {
    const payload = { ...toCamel(r as Record<string, unknown>), id: nextId }
    const evt: RemoteEvent = {
      eventId: crypto.randomUUID(), deviceId: 'neon-banquet-recover',
      entity: 'Payment', entityId: nextId, operation: 'create', revision: 1,
      payloadHash: `r33-banquet-${nextId}`, payload,
    }
    const out = await ingestRemoteEvent(evt)
    const chk = await db.payment.findUnique({ where: { id: nextId }, select: { amount: true } })
    console.log(`Neon pay#${r.id} (order 324, ${r.amount}) → local ${nextId}: ${out.outcome} ${chk ? chk.amount : 'MISSING'}`)
    nextId++
  }
  // verify order 324 payment sum locally
  const pays = await db.payment.findMany({ where: { orderId: 324 }, select: { amount: true } })
  const sum = pays.reduce((s, p) => s + p.amount, 0)
  const o = await db.order.findUnique({ where: { id: 324 }, select: { totalAmount: true } })
  console.log(`order 324: ${pays.length} payments, sum=${sum.toFixed(2)}, total=${o?.totalAmount} → ${Math.abs(sum - (o?.totalAmount ?? 0)) < 0.02 ? '✓ CONSISTENT' : 'MISMATCH'}`)
  console.log('local payments now:', await db.payment.count())
  await pool.end()
  await db.$disconnect()
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
