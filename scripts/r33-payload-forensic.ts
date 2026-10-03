import { Pool } from 'pg'
import { neonPooledUrl } from './lib/env-local'
async function main() {
  const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
  // FK constraints on orders table
  const fk = await pool.query(`SELECT conname, pg_get_constraintdef(oid) def FROM pg_constraint WHERE conrelid = 'orders'::regclass AND contype = 'f'`)
  console.log('orders FKs:')
  for (const r of fk.rows) console.log('  ', r.conname, '→', r.def)
  // payload of the applied create vs the dead update for 1211
  const create = await pool.query(`SELECT payload FROM hybrid_events WHERE id = 5516`)
  const p1 = JSON.parse(create.rows[0].payload)
  console.log('1211 create payload keys:', Object.keys(p1).join(','))
  console.log('  user_id:', p1.user_id, '| table_id:', p1.table_id, '| status:', p1.status)
  const upd = await pool.query(`SELECT payload, "lastError" FROM hybrid_events WHERE id = 5520`)
  const p2 = JSON.parse(upd.rows[0].payload)
  console.log('1211 update(rev3) payload keys:', Object.keys(p2).join(','))
  console.log('  user_id:', p2.user_id, '| table_id:', p2.table_id, '| status:', p2.status)
  await pool.end()
}
main().then(() => process.exit(0)).catch(e => { console.error('ERR', e.message); process.exit(1) })
