import { Pool } from 'pg'
import { neonPooledUrl } from '../lib/env-local'
import { db } from '../../src/lib/db'
const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
const seq = await pool.query(`SELECT last_value::int v FROM categories_id_seq`)
console.log('Neon categories_id_seq after push+apply:', seq.rows[0].v, seq.rows[0].v >= 28 ? '✓ SELF-HEALED' : '✗ NOT healed (fix not live or event not applied)')
const cat = await pool.query('SELECT id, name, display_order FROM categories WHERE id = 28')
console.log('Neon category 28:', JSON.stringify(cat.rows[0]))
const ev = await db.hybridEvent.findFirst({ where: { entity: 'Category', entityId: 28 }, orderBy: { id: 'desc' } })
console.log('local outbox Category#28 latest:', ev ? `${ev.status} rev${ev.revision} ackedAt=${ev.ackedAt?.toISOString?.() ?? 'null'}` : 'NONE')
await pool.end()
await db.$disconnect()
