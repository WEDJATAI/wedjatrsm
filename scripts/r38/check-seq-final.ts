import { Pool } from 'pg'
import { neonPooledUrl } from '../lib/env-local'
const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
const seq = await pool.query(`SELECT last_value::int v FROM categories_id_seq`)
console.log('Neon categories_id_seq:', seq.rows[0].v, seq.rows[0].v >= 28 ? '✓ SELF-HEALED by deployed fix' : '✗ still low')
const cat = await pool.query('SELECT id, name, display_order FROM categories WHERE id = 28')
console.log('Neon category 28:', JSON.stringify(cat.rows[0]), cat.rows[0].display_order >= 33 ? '✓ local edit landed' : '(displayOrder not yet propagated)')
const hev = await pool.query("SELECT \"entityId\", operation, revision, status, direction FROM hybrid_events WHERE entity='Category' AND \"entityId\"=28 ORDER BY id DESC LIMIT 2")
console.log('Neon hybrid_events Category#28:', JSON.stringify(hev.rows))
await pool.end()
