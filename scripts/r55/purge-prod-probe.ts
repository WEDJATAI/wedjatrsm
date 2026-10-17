// r55 — zero-residue purge of the production E2E probe (order 2213).
import { Pool } from 'pg'
import { createHash, randomUUID } from 'crypto'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'fs'
const env = Object.fromEntries(
  readFileSync('.env.deploy-local', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const ORDER_ID = 2213
const WIPE_MARKER = 'rsm-owner-wipe-v1'
let failed = 0
const ok = (c: boolean, l: string) => { console.log(`  ${c ? '✓' : '✗ FAIL'} — ${l}`); if (!c) failed++ }
const local = new Database('/home/z/my-project/db/custom.db')
const pool = new Pool({ connectionString: env.NEON_DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 })

local.query(`INSERT INTO hybrid_sync_state (key, value, "updatedAt") VALUES ('sync.paused','1',datetime('now')) ON CONFLICT(key) DO UPDATE SET value='1', "updatedAt"=datetime('now')`).run()
await new Promise((r) => setTimeout(r, 2000))
local.transaction(() => {
  const p = local.query(`DELETE FROM payments WHERE order_id=${ORDER_ID}`).run()
  const it = local.query(`DELETE FROM order_items WHERE order_id=${ORDER_ID}`).run()
  const a = local.query(`DELETE FROM audit_logs WHERE entity='order' AND entity_id=${ORDER_ID}`).run()
  const o = local.query(`DELETE FROM orders WHERE id=${ORDER_ID}`).run()
  console.log(`local: payments=${p.changes} items=${it.changes} audits=${a.changes} orders=${o.changes}`)
})()

const client = await pool.connect()
await client.query('BEGIN')
try {
  const auditIds = (await client.query(`SELECT id FROM audit_logs WHERE entity='order' AND entity_id=$1`, [ORDER_ID])).rows.map((r: any) => Number(r.id))
  const p = await client.query(`DELETE FROM payments WHERE order_id=$1`, [ORDER_ID])
  const it = await client.query(`DELETE FROM order_items WHERE order_id=$1`, [ORDER_ID])
  const a = await client.query(`DELETE FROM audit_logs WHERE entity='order' AND entity_id=$1`, [ORDER_ID])
  const o = await client.query(`DELETE FROM orders WHERE id=$1`, [ORDER_ID])
  console.log(`cloud: payments=${p.rowCount} items=${it.rowCount} audits=${a.rowCount} orders=${o.rowCount}`)
  const emit = async (entity: string, entityId: string, operation: string, revision: number, payload: object) => {
    const body = JSON.stringify(payload)
    await client.query(
      `INSERT INTO hybrid_events ("eventId","deviceId","entity","entityId","operation","revision","payloadHash","payload","direction","status","attempts","createdAt","updatedAt")
       VALUES ($1,'unbound',$2,$3,$4,$5,$6,$7,'out','pending',0,now(),now())`,
      [randomUUID(), entity, entityId, operation, revision, createHash('sha256').update(body).digest('hex'), body],
    )
  }
  const maxRev = async (entity: string, entityId: string) =>
    Number((await client.query(`SELECT COALESCE(MAX(revision),0) rev FROM hybrid_events WHERE entity=$1 AND "entityId"=$2`, [entity, entityId])).rows[0].rev)
  for (const id of auditIds) await emit('AuditLog', String(id), 'delete', (await maxRev('AuditLog', String(id))) + 1, { id, __wipe: WIPE_MARKER })
  await emit('Order', String(ORDER_ID), 'delete', (await maxRev('Order', String(ORDER_ID))) + 1, { id: ORDER_ID })
  console.log(`supersede: ${auditIds.length} AuditLog wipes + 1 Order delete`)
  await client.query('COMMIT')
} catch (e) { await client.query('ROLLBACK'); throw e }
client.release()
local.query(`INSERT INTO hybrid_sync_state (key, value, "updatedAt") VALUES ('sync.paused','0',datetime('now')) ON CONFLICT(key) DO UPDATE SET value='0', "updatedAt"=datetime('now')`).run()

const preMax = Number((await pool.query(`SELECT MAX(id) m FROM hybrid_events`)).rows[0].m)
for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 15000))
  const cursor = Number((local.query(`SELECT value FROM hybrid_sync_state WHERE key='pull.cursor'`).get() as any).value)
  if (cursor >= preMax) break
}
const C = async (sql: string) => Number((await pool.query(sql)).rows[0].count)
const L = (sql: string) => Number((local.query(sql).get() as any).c)
ok(L(`SELECT COUNT(*) c FROM orders`) === 0 && await C(`SELECT COUNT(*) FROM orders`) === 0, 'orders 0/0')
ok(L(`SELECT COUNT(*) c FROM payments`) === 0 && await C(`SELECT COUNT(*) FROM payments`) === 0, 'payments 0/0')
ok(L(`SELECT COUNT(*) c FROM order_items`) === 0 && await C(`SELECT COUNT(*) FROM order_items`) === 0, 'items 0/0')
ok(L(`SELECT COUNT(*) c FROM audit_logs WHERE entity='order'`) === 0 && await C(`SELECT COUNT(*) FROM audit_logs WHERE entity='order'`) === 0, 'order audits 0/0')
ok(L(`SELECT COUNT(*) c FROM hybrid_events WHERE direction='in' AND status='failed'`) === 0, 'no failed in-events')
await pool.end(); local.close()
console.log(failed === 0 ? '\nPRODUCTION PROBE PURGED — zero residue' : `\n${failed} FAILURE(S)`)
process.exit(failed === 0 ? 0 : 1)
