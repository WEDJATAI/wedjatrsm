import { Pool } from 'pg'
import { db } from '../../src/lib/db'
import { neonPooledUrl } from '../lib/env-local'
const pool = new Pool({ connectionString: neonPooledUrl(), max: 1 })

console.log('=== NEON users NOW ===')
for (const u of (await pool.query('select id, email, name, role, is_super_admin, active, created_at from users order by id')).rows)
  console.log(`  #${u.id} role=${u.role} super=${u.is_super_admin} email=${u.email} name="${u.name}" active=${u.active} created=${u.created_at.toISOString().slice(0,16)}`)
console.log('=== NEON persons NOW ===')
for (const p of (await pool.query('select id, user_id, name, active from persons order by id')).rows)
  console.log(`  #${p.id} user=${p.user_id} name="${p.name}" active=${p.active}`)
console.log('=== NEON audit_logs NOW ===')
for (const a of (await pool.query('select id, user_name, action, entity, entity_id, created_at from audit_logs order by id')).rows)
  console.log(`  #${a.id} "${a.user_name}" ${a.action} ${a.entity}/${a.entity_id} at=${a.created_at.toISOString().slice(0,16)}`)
console.log('=== NEON orders/payments/customers NOW ===')
for (const t of ['orders','payments','customers','promotions','attendance'])
  console.log(`  ${t}:`, (await pool.query(`select count(*)::int c from ${t}`)).rows[0].c)
console.log('=== LOCAL users NOW ===')
for (const u of await db.user.findMany({ orderBy: { id: 'asc' } }))
  console.log(`  #${u.id} role=${u.role} email=${u.email} name="${u.name}" active=${u.active} created=${u.createdAt.toISOString().slice(0,16)}`)
await pool.end(); await db.$disconnect()
