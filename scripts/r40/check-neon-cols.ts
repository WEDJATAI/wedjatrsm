import { Pool } from 'pg'
import { neonPooledUrl } from '../lib/env-local'
const pool = new Pool({ connectionString: neonPooledUrl(), max: 1 })
const q = async (sql: string) => (await pool.query(sql)).rows
console.log('vision_table_states columns:')
for (const c of await q("select column_name from information_schema.columns where table_name='vision_table_states' order by ordinal_position"))
  console.log(' ', c.column_name)
console.log('\nneon counts now (post local-commit, neon untouched):')
for (const t of ['orders','payments','customers','audit_logs','attendance','users','persons'])
  console.log(`  ${t}:`, (await q(`select count(*)::int c from ${t}`))[0].c)
console.log('\ntables not free:', (await q("select count(*)::int c from tables where status <> 'free'"))[0].c)
await pool.end()
