// r58 — zero-residue purge of the desktop-download E2E round from Neon:
//   · probe order #2224 (+ items + its audits) with supersede events
//   · the two E2E hybrid devices (6ee96f08… + 4dfe1fc8…) + their enrollment
//     audits (superseded too — every device drops them on next pull)
// The E2E platform tree itself (~/.rsm-platform) is deleted afterwards.
import { Pool } from 'pg'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('/home/z/my-project/.env.deploy-local', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const pool = new Pool({ connectionString: env.NEON_DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 })
const WIPE = 'rsm-owner-wipe-v1'
let failed = 0
const ok = (c: boolean, l: string) => { console.log(`  ${c ? '✓' : '✗ FAIL'} — ${l}`); if (!c) failed++ }

const probe = JSON.parse(readFileSync('/tmp/verify-2way-e2e.json', 'utf8'))
const ORDER = probe.orderA as number

// the E2E devices (this round's enrollments: 6ee96f08 from the earlier runs,
// 4dfe1fc8 from the final fresh-install run) + their enrollment audits
const devices = (await pool.query(
  `SELECT "deviceId", name FROM hybrid_devices WHERE "deviceId" LIKE '6ee96f08%' OR "deviceId" LIKE '4dfe1fc8%' OR name LIKE '%c-6ad3b07e%RSM Desktop%'`,
)).rows
const enrollAudits = (await pool.query(
  `SELECT id FROM audit_logs WHERE action='hybrid.deviceSelfEnroll' AND (details LIKE '%6ee96f08%' OR details LIKE '%4dfe1fc8%' OR details LIKE '%c-6ad3b07e%')`,
)).rows

const client = await pool.connect()
await client.query('BEGIN')
try {
  // probe order surgery
  const orderAudits = (await client.query(`SELECT id FROM audit_logs WHERE entity='order' AND entity_id=$1`, [ORDER])).rows
  const it = await client.query(`DELETE FROM order_items WHERE order_id=$1`, [ORDER])
  const pay = await client.query(`DELETE FROM payments WHERE order_id=$1`, [ORDER])
  const oa = await client.query(`DELETE FROM audit_logs WHERE entity='order' AND entity_id=$1`, [ORDER])
  const or_ = await client.query(`DELETE FROM orders WHERE id=$1`, [ORDER])
  console.log(`order #${ORDER}: items=${it.rowCount} payments=${pay.rowCount} audits=${oa.rowCount} orders=${or_.rowCount}`)

  // E2E device registry rows + enrollment audits
  const dv = await client.query(`DELETE FROM hybrid_devices WHERE "deviceId" = ANY($1)`, [devices.map((d: any) => d.deviceId)])
  console.log(`devices: ${dv.rowCount} (${devices.map((d: any) => d.deviceId.slice(0, 8)).join(', ')})`)
  const ea = await client.query(`DELETE FROM audit_logs WHERE id = ANY($1)`, [enrollAudits.map((a: any) => a.id)])
  console.log(`enrollment audits: ${ea.rowCount} (${enrollAudits.map((a: any) => a.id).join(', ')})`)

  // supersede emission (r55 pattern) so every device drops the rows on pull
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
  for (const a of orderAudits) await emit('AuditLog', String(a.id), 'delete', (await maxRev('AuditLog', String(a.id))) + 1, { id: a.id, __wipe: WIPE })
  await emit('Order', String(ORDER), 'delete', (await maxRev('Order', String(ORDER)) + 1), { id: ORDER })
  for (const a of enrollAudits) await emit('AuditLog', String(a.id), 'delete', (await maxRev('AuditLog', String(a.id))) + 1, { id: a.id, __wipe: WIPE })
  console.log(`supersede: ${orderAudits.length + enrollAudits.length} AuditLog wipes + 1 Order delete`)
  await client.query('COMMIT')
} catch (e) { await client.query('ROLLBACK'); throw e }
client.release()

// final verification — the E2E residue is gone, live data intact
const C = async (sql: string, p?: unknown[]) => Number((await pool.query(sql, p)).rows[0].count)
ok((await C(`SELECT COUNT(*) FROM orders WHERE id=$1`, [ORDER])) === 0, `order #${ORDER} gone from Neon`)
ok((await C(`SELECT COUNT(*) FROM orders WHERE id=$1`, [2214])) === 1, `protected order #2214 intact (other open orders are the owner's LIVE activity — untouched)`)
ok((await C(`SELECT COUNT(*) FROM hybrid_devices WHERE "deviceId" LIKE '6ee96f08%' OR "deviceId" LIKE '4dfe1fc8%'`)) === 0, 'E2E devices purged')
ok((await C(`SELECT COUNT(*) FROM audit_logs WHERE (action='hybrid.deviceSelfEnroll' AND (details LIKE '%6ee96f08%' OR details LIKE '%4dfe1fc8%')) OR (entity='order' AND entity_id=$1)`, [ORDER])) === 0, 'E2E audits purged')
await pool.end()
console.log(failed === 0 ? 'E2E PURGE COMPLETE — zero residue' : `${failed} FAILURES`)
process.exit(failed === 0 ? 0 : 1)
