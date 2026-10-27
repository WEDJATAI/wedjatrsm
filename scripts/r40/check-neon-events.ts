import { Pool } from 'pg'
import { neonPooledUrl } from '../lib/env-local'
const pool = new Pool({ connectionString: neonPooledUrl(), max: 1 })
const q = async (sql: string) => (await pool.query(sql)).rows
console.log('=== NEON hybrid_events columns ===')
console.log((await q("select column_name from information_schema.columns where table_name='hybrid_events' order by ordinal_position")).map((c: any) => c.column_name).join(', '))
console.log('=== NEON newest events (id > 11039) ===')
for (const e of await q('select id, direction, status, entity, "entityId", operation, "createdAt" from hybrid_events where id > 11039 order by id'))
  console.log(`  #${e.id} ${e.direction}/${e.status} ${e.entity}/${e.entityId} ${e.operation} at=${e.createdAt.toISOString().slice(0,19)}`)
console.log('=== NEON resurrection check ===')
for (const t of ['audit_logs', 'orders', 'payments', 'customers', 'promotions', 'inventory_transactions', 'attendance'])
  console.log(`  ${t}:`, (await q(`select count(*)::int c from ${t}`))[0].c)
console.log('=== NEON promotion rows ===')
for (const p of await q('select id, name from promotions'))
  console.log(`  #${p.id} ${p.name}`)
await pool.end()
