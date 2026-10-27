import { Pool } from 'pg'
import { neonPooledUrl } from './lib/env-local'
async function main() {
  const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
  const ev = await pool.query(`SELECT id, entity, "entityId", operation, revision, direction, status, "createdAt", "lastError" FROM hybrid_events WHERE entity='Order' AND "entityId"='328' ORDER BY revision, id`)
  console.log('Neon events for Order/328:')
  for (const r of ev.rows) console.log('  ', r.id, r.operation, 'rev' + r.revision, r.direction, r.status, new Date(Number(r.createdAt)).toISOString().slice(0, 16), r.lastError ? 'err:' + String(r.lastError).slice(0, 40) : '')
  const cf = await pool.query(`SELECT "eventId", reason, resolution, details, "createdAt" FROM hybrid_conflicts WHERE entity='Order' AND "entityId"='328' ORDER BY id DESC LIMIT 8`)
  console.log('Neon conflicts for Order/328:')
  for (const r of cf.rows) console.log('  ', new Date(Number(r.createdAt)).toISOString().slice(0, 16), r.reason, r.resolution, String(r.details).slice(0, 50))
  await pool.end()
}
main().then(() => process.exit(0)).catch(e => { console.error('ERR', e.message); process.exit(1) })
