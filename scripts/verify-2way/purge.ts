// verify-2way — zero-residue purge of the two probe orders (2215 local UP
// probe, 2216 production webhook DOWN probe) from BOTH planes, with the
// r55 supersede pattern so every other device drops them on next pull.
// Real business data (order 2214 — Karim's cancelled live check) untouched.
import { Pool } from 'pg'
import { createHash, randomUUID } from 'crypto'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'fs'
const env = Object.fromEntries(
  readFileSync('.env.deploy-local', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const ORDER_IDS = [2215, 2216]
const KEEP = 2214 // real live data — never touched
const WIPE_MARKER = 'rsm-owner-wipe-v1'
let failed = 0
const ok = (c: boolean, l: string) => { console.log(`  ${c ? '✓' : '✗ FAIL'} — ${l}`); if (!c) failed++ }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const local = new Database('/home/z/my-project/db/custom.db')
const pool = new Pool({ connectionString: env.NEON_DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 })

// pause the engine so nothing races the surgery
local.query(`INSERT INTO hybrid_sync_state (key, value, "updatedAt") VALUES ('sync.paused','1',datetime('now')) ON CONFLICT(key) DO UPDATE SET value='1', "updatedAt"=datetime('now')`).run()
await sleep(2000)

// local surgery
local.transaction(() => {
  const idl = ORDER_IDS.join(',')
  const p = local.query(`DELETE FROM payments WHERE order_id IN (${idl})`).run()
  const it = local.query(`DELETE FROM order_items WHERE order_id IN (${idl})`).run()
  const a = local.query(`DELETE FROM audit_logs WHERE entity='order' AND entity_id IN (${idl})`).run()
  const o = local.query(`DELETE FROM orders WHERE id IN (${idl})`).run()
  console.log(`local: payments=${p.changes} items=${it.changes} audits=${a.changes} orders=${o.changes}`)
})()

// cloud surgery + supersede emission (single transaction)
const client = await pool.connect()
await client.query('BEGIN')
try {
  const auditIds: number[] = []
  for (const id of ORDER_IDS) {
    const rows = (await client.query(`SELECT id FROM audit_logs WHERE entity='order' AND entity_id=$1`, [id])).rows
    auditIds.push(...rows.map((r: any) => Number(r.id)))
  }
  const p = await client.query(`DELETE FROM payments WHERE order_id = ANY($1)`, [ORDER_IDS])
  const it = await client.query(`DELETE FROM order_items WHERE order_id = ANY($1)`, [ORDER_IDS])
  const a = await client.query(`DELETE FROM audit_logs WHERE entity='order' AND entity_id = ANY($1)`, [ORDER_IDS])
  const o = await client.query(`DELETE FROM orders WHERE id = ANY($1)`, [ORDER_IDS])
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
  for (const id of ORDER_IDS) await emit('Order', String(id), 'delete', (await maxRev('Order', String(id))) + 1, { id })
  console.log(`supersede: ${auditIds.length} AuditLog wipes + ${ORDER_IDS.length} Order deletes`)
  await client.query('COMMIT')
} catch (e) { await client.query('ROLLBACK'); throw e }
client.release()
local.query(`INSERT INTO hybrid_sync_state (key, value, "updatedAt") VALUES ('sync.paused','0',datetime('now')) ON CONFLICT(key) DO UPDATE SET value='0', "updatedAt"=datetime('now')`).run()

// wait for the desktop to pull the supersede stream (cursor catches up)
const preMax = Number((await pool.query(`SELECT MAX(id) m FROM hybrid_events`)).rows[0].m)
for (let i = 0; i < 20; i++) {
  await sleep(10000)
  const cursor = Number((local.query(`SELECT value FROM hybrid_sync_state WHERE key='pull.cursor'`).get() as any).value)
  if (cursor >= preMax) break
}

// final parity — probes gone, live data intact, engine healthy
const C = async (sql: string) => Number((await pool.query(sql)).rows[0].count)
const L = (sql: string) => Number((local.query(sql).get() as any).c)
ok(L(`SELECT COUNT(*) c FROM orders`) === 1 && await C(`SELECT COUNT(*) FROM orders WHERE id != ${KEEP}`) === 0, `orders 1/1 (only live #${KEEP} on both planes)`)
ok(L(`SELECT COUNT(*) c FROM orders WHERE id=${KEEP}`) === 1 && await C(`SELECT COUNT(*) FROM orders WHERE id=${KEEP}`) === 1, `live order #${KEEP} intact on both planes`)
ok(L(`SELECT COUNT(*) c FROM order_items WHERE order_id IN (2215,2216)`) === 0 && await C(`SELECT COUNT(*) FROM order_items WHERE order_id = ANY(ARRAY[2215,2216])`) === 0, 'probe items 0/0')
ok(L(`SELECT COUNT(*) c FROM audit_logs WHERE entity='order' AND entity_id IN (2215,2216)`) === 0, 'probe audits 0 locally')
ok(await C(`SELECT COUNT(*) FROM audit_logs WHERE entity='order' AND entity_id = ANY(ARRAY[2215,2216])`) === 0, 'probe audits 0 on cloud')
ok(L(`SELECT COUNT(*) c FROM hybrid_events WHERE direction='in' AND status='failed'`) === 0, 'no failed in-events')
ok(L(`SELECT COUNT(*) c FROM hybrid_events WHERE direction='out' AND status='pending'`) === 0, 'outbox drained')
await pool.end(); local.close()
console.log(failed === 0 ? `\nPROBES PURGED — zero residue, live data intact` : `\n${failed} FAILURE(S)`)
process.exit(failed === 0 ? 0 : 1)
