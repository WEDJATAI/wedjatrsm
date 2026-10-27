import { Pool } from 'pg'
import { neonPooledUrl } from '../lib/env-local'
const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
// 1) artificially lower categories seq (simulating the drift state)
await pool.query(`SELECT setval(pg_get_serial_sequence('categories','id'), 5, true)`)
const before = await pool.query(`SELECT last_value::int v FROM categories_id_seq`)
console.log('seq artificially lowered to:', before.rows[0].v)
await pool.end()
