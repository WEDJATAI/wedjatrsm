/** r33: pull September-era payments (orders 108-139 paysum=0 locally) from Neon. */
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
const ORDERS = [108, 126, 127, 128, 129, 132, 133, 136, 139]
async function main() {
  const pool = new pg.Pool({ connectionString: neonUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
  let nextId = 251
  const map: string[] = []
  for (const oid of ORDERS) {
    const localCount = await db.payment.count({ where: { orderId: oid } })
    const rows = await pool.query(`SELECT * FROM payments WHERE order_id = $1 ORDER BY id`, [oid])
    if (!rows.rows.length) { console.log(`order ${oid}: no Neon payments either — document as artifact`); continue }
    if (localCount >= rows.rows.length) { console.log(`order ${oid}: local has ${localCount}, neon ${rows.rows.length} — skip`); continue }
    for (const r of rows.rows) {
      const payload = { ...toCamel(r as Record<string, unknown>), id: nextId }
      const evt: RemoteEvent = {
        eventId: crypto.randomUUID(), deviceId: 'neon-sept-recover',
        entity: 'Payment', entityId: nextId, operation: 'create', revision: 1,
        payloadHash: `r33-sept-${nextId}`, payload,
      }
      const out = await ingestRemoteEvent(evt)
      console.log(`order ${oid}: Neon pay#${r.id} ${r.amount} → local ${nextId}: ${out.outcome}`)
      map.push(`${nextId}=neon#${r.id}(o${oid})`)
      nextId++
    }
  }
  console.log('ID MAP:', map.join(' '))
  // verify
  for (const oid of ORDERS) {
    const pays = await db.payment.findMany({ where: { orderId: oid }, select: { amount: true } })
    const sum = pays.reduce((s, p) => s + p.amount, 0)
    const o = await db.order.findUnique({ where: { id: oid }, select: { totalAmount: true } })
    if (o) console.log(`order ${oid}: sum=${sum.toFixed(2)} total=${o.totalAmount} ${Math.abs(sum - o.totalAmount) < 0.02 ? '✓' : 'still off'}`)
  }
  console.log('local payments now:', await db.payment.count())
  await pool.end()
  await db.$disconnect()
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
