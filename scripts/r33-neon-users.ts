import { Pool } from 'pg'
import { neonPooledUrl } from './lib/env-local'
async function main() {
  const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
  const u = await pool.query('SELECT id, name, email, role FROM users ORDER BY id')
  console.log('NEON users:')
  for (const r of u.rows) console.log(' ', r.id, String(r.role).padEnd(10), r.name, '<' + r.email + '>')
  await pool.end()
}
main().then(() => process.exit(0)).catch(e => { console.error('ERR', e.message); process.exit(1) })
