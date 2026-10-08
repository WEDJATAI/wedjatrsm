import { Pool } from 'pg'
import { neonPooledUrl } from './lib/env-local'
async function main() {
  const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
  const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='products' ORDER BY ordinal_position`)
  console.log('product cols:', cols.rows.map((r: any) => r.column_name).join(','))
  const pr = await pool.query(`SELECT * FROM products WHERE id IN (226,227,228,229)`)
  for (const r of pr.rows) console.log('  ', r.id, JSON.stringify(r).slice(0, 260))
  // persons/attendance referencing 14?
  const p14 = await pool.query(`SELECT id, name, user_id FROM persons WHERE user_id = 14`)
  console.log('persons w/ user_id=14:', p14.rows.length ? p14.rows.map((x: any) => x.id + ':' + x.name).join(',') : 'none')
  const a14 = await pool.query(`SELECT COUNT(*)::int c FROM attendance WHERE user_id = 14`)
  console.log('attendance rows user_id=14:', a14.rows[0].c)
  await pool.end()
}
main().then(() => process.exit(0)).catch(e => { console.error('ERR', e.message); process.exit(1) })
