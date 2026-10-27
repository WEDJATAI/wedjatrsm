// r62 — zero-residue purge of the fresh-install E2E round from Neon:
//   · probe order #2228 (+ items + payments + its audits) with supersede events
//   · the E2E hybrid device (69f7dbd2…) + its enrollment audit
// The E2E platform tree (/tmp/r62-e2e) is deleted afterwards.
import { Pool } from 'pg'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.deploy-local', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const pool = new Pool({ connectionString: env.NEON_DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 })
const WIPE = 'rsm-owner-wipe-v1'
const ORDER = 2228
let failed = 0
const ok = (c: boolean, l: string) => { console.log(`  ${c ? '✓' : '✗ FAIL'} — ${l}`); if (!c) failed++ }

const devices = (await pool.query(`SELECT "deviceId", name FROM hybrid_devices WHERE "deviceId" LIKE '69f7dbd2%' OR name LIKE '%r62 E2E%' OR name LIKE '%r62-e2e%'`)).rows
const enrollAudits = (await pool.query(`SELECT id FROM audit_logs WHERE (action='hybrid.deviceSelfEnroll' OR action='hybrid.deviceCreate') AND (details LIKE '%69f7dbd2%' OR details LIKE '%r62 E2E%' OR details LIKE '%r62-e2e%')`)).rows

const client = await pool.connect()
await client.query('BEGIN')
try {
  const orderAudits = (await client.query(`SELECT id FROM audit_logs WHERE entity='order' AND entity_id=$1`, [ORDER])).rows
  const it = await client.query(`DELETE FROM order_items WHERE order_id=$1`, [ORDER])
  const pay = await client.query(`DELETE FROM payments WHERE order_id=$1`, [ORDER])
  const oa = await client.query(`DELETE FROM audit_logs WHERE entity='order' AND entity_id=$1`, [ORDER])
  const or_ = await client.query(`DELETE FROM orders WHERE id=$1`, [ORDER])
  const dev = await client.query(`DELETE FROM hybrid_devices WHERE "deviceId" = ANY($1::text[])`, [devices.map((d: any) => d.deviceId)])
  const ea = await client.query(`DELETE FROM audit_logs WHERE id = ANY($1::int[])`, [enrollAudits.map((a: any) => a.id)])
  await client.query(`SELECT setval(pg_get_serial_sequence('audit_logs','id'), (SELECT MAX(id) FROM audit_logs))`)

  // supersede emission (r55 pattern) so every device drops the rows on pull
  const maxRev = async (entity: string, entityId: string) =>
    Number((await client.query(`SELECT COALESCE(MAX(revision),0) r FROM hybrid_events WHERE entity=$1 AND "entityId"=$2`, [entity, entityId])).rows[0].r)
  const canon = (v: any): any => {
    if (v instanceof Date) return v.toISOString()
    if (v === undefined || v === null) return null
    if (Array.isArray(v)) return v.map(canon)
    if (typeof v === 'object') { const o: Record<string, any> = {}; for (const k of Object.keys(v).sort()) o[k] = canon(v[k]); return o }
    return v
  }
  const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
  const emit = async (entity: string, entityId: number, operation: string, revision: number, payload: any) => {
    const body = JSON.stringify(canon(payload))
    await client.query(
      `INSERT INTO hybrid_events ("eventId","deviceId","entity","entityId","operation","revision","payloadHash","payload","direction","status","attempts","createdAt","updatedAt")
       VALUES ($1,'unbound',$2,$3,$4,$5,$6,$7,'out','pending',0,now(),now())`,
      [randomUUID(), entity, entityId, operation, revision, sha(body), body],
    )
  }
  await emit('Order', ORDER, 'delete', (await maxRev('Order', String(ORDER))) + 1, { id: ORDER, __wipe: WIPE })
  for (const a of orderAudits) await emit('AuditLog', Number(a.id), 'delete', (await maxRev('AuditLog', String(a.id))) + 1, { id: Number(a.id), __wipe: WIPE })
  for (const a of enrollAudits) await emit('AuditLog', Number(a.id), 'delete', (await maxRev('AuditLog', String(a.id))) + 1, { id: Number(a.id), __wipe: WIPE })
  await client.query('COMMIT')

  ok(or_.rowCount === 1, `order #2228 deleted (${or_.rowCount})`)
  ok(it.rowCount === 1 && pay.rowCount === 0, `items ${it.rowCount} · payments ${pay.rowCount} deleted`)
  ok(dev.rowCount === devices.length && devices.length === 1, `E2E device deleted (${dev.rowCount}/${devices.length})`)
  ok(ea.rowCount === enrollAudits.length, `enrollment audits deleted (${ea.rowCount}/${enrollAudits.length})`)
  console.log(`supersede: ${orderAudits.length + enrollAudits.length} AuditLog wipes + 1 Order delete`)
} catch (e) {
  await client.query('ROLLBACK')
  client.release()
  throw e
}
client.release()

// keep-set re-assertion
const prods = Number((await pool.query('SELECT COUNT(*) c FROM products')).rows[0].c)
const cats = Number((await pool.query('SELECT COUNT(*) c FROM categories')).rows[0].c)
const orders = (await pool.query('SELECT COUNT(*) c FROM orders')).rows[0].c
const mazaj = Number((await pool.query(`SELECT COUNT(*) c FROM products WHERE sku LIKE 'MAZAJ%'`)).rows[0].c)
ok(prods === 211 && cats === 20, `v11 menu intact after purge (products ${prods} · categories ${cats})`)
ok(Number(orders) === 4, `owner's orders intact (${orders} — #2214/#2221/#2222/#2223)`)
ok(mazaj === 13, `13 MAZAJ shisha products intact`)

await pool.end()
console.log(failed === 0 ? '\n[r62-purge] ZERO RESIDUE — probe + E2E device gone, live data intact' : `\n[r62-purge] ${failed} FAILURE(S)`)
process.exit(failed === 0 ? 0 : 1)
