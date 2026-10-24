import { Pool } from 'pg'
import { db } from '../../src/lib/db'
import { neonPooledUrl } from '../lib/env-local'
const pool = new Pool({ connectionString: neonPooledUrl(), max: 1 })

console.log('=== LOCAL newest out events (id > 11987) ===')
for (const e of await db.hybridEvent.findMany({ where: { id: { gt: 11987 } }, orderBy: { id: 'asc' } }))
  console.log(`  #${e.id} ${e.direction}/${e.status} ${e.entity}/${e.entityId} ${e.operation} at=${e.createdAt.toISOString().slice(0,19)} err=${e.lastError?.slice(0,40) ?? '-'}`)
console.log('=== LOCAL newest in events ===')
for (const e of await db.hybridEvent.findMany({ where: { direction: 'in' }, orderBy: { id: 'desc' }, take: 7 }))
  console.log(`  #${e.id} ${e.direction}/${e.status} ${e.entity}/${e.entityId} ${e.operation} at=${e.createdAt.toISOString().slice(0,19)}`)
console.log('=== NEON newest events (id > 11046) ===')
for (const e of (await pool.query('select id, direction, status, entity, entity_id, operation, created_at from hybrid_events where id > 11046 order by id')).rows)
  console.log(`  #${e.id} ${e.direction}/${e.status} ${e.entity}/${e.entity_id} ${e.operation} at=${e.created_at.toISOString().slice(0,19)}`)
console.log('=== NEON audit_logs / orders count (resurrection check) ===')
const a = (await pool.query('select count(*)::int c from audit_logs')).rows[0].c
const o = (await pool.query('select count(*)::int c from orders')).rows[0].c
console.log(`  neon audit_logs=${a} orders=${o} (must both be 0)`)
await pool.end(); await db.$disconnect()
