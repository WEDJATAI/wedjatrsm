// r55 — zero-residue purge of the 3 E2E probe orders (2210, 2211, 2212),
// both planes, with supersede events (the r47/r55 discipline).
import { Pool } from 'pg'
import { createHash, randomUUID } from 'crypto'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'fs'
const env = Object.fromEntries(
  readFileSync('.env.deploy-local', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const PROBES = [2210, 2211, 2212]
const WIPE_MARKER = 'rsm-owner-wipe-v1'
let failed = 0
const ok = (c: boolean, l: string) => { console.log(`  ${c ? '✓' : '✗ FAIL'} — ${l}`); if (!c) failed++ }

const local = new Database('/home/z/my-project/db/custom.db')
const pool = new Pool({ connectionString: env.NEON_DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 })

// pause engine during surgery
local.query(`INSERT INTO hybrid_sync_state (key, value, "updatedAt") VALUES ('sync.paused','1',datetime('now')) ON CONFLICT(key) DO UPDATE SET value='1', "updatedAt"=datetime('now')`).run()
await new Promise((r) => setTimeout(r, 2000))

// LOCAL
local.transaction(() => {
  const p = local.query(`DELETE FROM payments WHERE order_id IN (2210,2211,2212)`).run()
  const it = local.query(`DELETE FROM order_items WHERE order_id IN (2210,2211,2212)`).run()
  const a = local.query(`DELETE FROM audit_logs WHERE entity='order' AND entity_id IN (2210,2211,2212)`).run()
  const o = local.query(`DELETE FROM orders WHERE id IN (2210,2211,2212)`).run()
  console.log(`local purge: payments=${p.changes} items=${it.changes} audits=${a.changes} orders=${o.changes}`)
})()

// CLOUD + supersede events
const client = await pool.connect()
await client.query('BEGIN')
try {
  const auditIds = (await client.query(`SELECT id FROM audit_logs WHERE entity='order' AND entity_id = ANY($1) ORDER BY id`, [PROBES])).rows.map((r: any) => Number(r.id))
  const p = await client.query(`DELETE FROM payments WHERE order_id = ANY($1)`, [PROBES])
  const it = await client.query(`DELETE FROM order_items WHERE order_id = ANY($1)`, [PROBES])
  const a = await client.query(`DELETE FROM audit_logs WHERE entity='order' AND entity_id = ANY($1)`, [PROBES])
  const o = await client.query(`DELETE FROM orders WHERE id = ANY($1)`, [PROBES])
  console.log(`cloud purge: payments=${p.rowCount} items=${it.rowCount} audits=${a.rowCount} orders=${o.rowCount}`)

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
  for (const id of auditIds) {
    await emit('AuditLog', String(id), 'delete', (await maxRev('AuditLog', String(id))) + 1, { id, __wipe: WIPE_MARKER })
  }
  for (const id of PROBES) {
    await emit('Order', String(id), 'delete', (await maxRev('Order', String(id))) + 1, { id })
  }
  console.log(`supersede: ${auditIds.length} AuditLog wipes + ${PROBES.length} Order deletes`)
  await client.query('COMMIT')
} catch (e) {
  await client.query('ROLLBACK')
  throw e
}
client.release()

// unpause
local.query(`INSERT INTO hybrid_sync_state (key, value, "updatedAt") VALUES ('sync.paused','0',datetime('now')) ON CONFLICT(key) DO UPDATE SET value='0', "updatedAt"=datetime('now')`).run()

// wait for the pull to consume the supersede events
const preMax = Number((await pool.query(`SELECT MAX(id) m FROM hybrid_events`)).rows[0].m)
for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 15000))
  const cursor = Number((local.query(`SELECT value FROM hybrid_sync_state WHERE key='pull.cursor'`).get() as any).value)
  if (cursor >= preMax) break
}

// verify both planes
const C = async (sql: string) => Number((await pool.query(sql)).rows[0].count)
const L = (sql: string) => Number((local.query(sql).get() as any).c)
ok(L(`SELECT COUNT(*) c FROM orders`) === 0 && await C(`SELECT COUNT(*) FROM orders`) === 0, 'orders 0/0 after probe purge')
ok(L(`SELECT COUNT(*) c FROM order_items`) === 0 && await C(`SELECT COUNT(*) FROM order_items`) === 0, 'items 0/0')
ok(L(`SELECT COUNT(*) c FROM payments`) === 0 && await C(`SELECT COUNT(*) FROM payments`) === 0, 'payments 0/0')
ok(L(`SELECT COUNT(*) c FROM audit_logs WHERE entity='order'`) === 0 && await C(`SELECT COUNT(*) FROM audit_logs WHERE entity='order'`) === 0, 'order audits 0/0')
ok(L(`SELECT COUNT(*) c FROM tables WHERE status NOT IN ('free','dirty')`) === 0, 'no occupied tables')
const fIn = L(`SELECT COUNT(*) c FROM hybrid_events WHERE direction='in' AND status='failed'`)
ok(fIn === 0, `no failed in-events (${fIn})`)
await pool.end(); local.close()
console.log(failed === 0 ? '\nPROBES PURGED — zero residue, live starts clean' : `\n${failed} FAILURE(S)`)
process.exit(failed === 0 ? 0 : 1)
