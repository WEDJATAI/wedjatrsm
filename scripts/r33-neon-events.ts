import { Pool } from 'pg'
import { neonPooledUrl } from './lib/env-local'
async function main() {
  const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
  for (const id of ['1211', '1214', '1215', '1216']) {
    const r = await pool.query(
      `SELECT id, entity, "entityId", operation, revision, direction, status, "ackedAt", "lastError"
       FROM hybrid_events WHERE entity='Order' AND "entityId"=$1 ORDER BY id`, [id])
    console.log(`Order ${id}:`, r.rows.length ? '' : 'NO EVENTS')
    for (const row of r.rows) console.log('  ', row.id, row.operation, 'rev' + row.revision, row.direction, row.status, 'ack:' + row.ackedAt, row.lastError ? 'err:' + String(row.lastError).slice(0, 60) : '')
  }
  // check order rows on neon
  const o = await pool.query(`SELECT id, status FROM orders WHERE id IN (1211,1214,1215,1216)`)
  console.log('order rows:', o.rows.map((x: any) => `${x.id}/${x.status}`).join(' '))
  await pool.end()
}
main().then(() => process.exit(0)).catch(e => { console.error('ERR', e.message); process.exit(1) })
