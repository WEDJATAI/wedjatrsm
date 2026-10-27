// r72: forensic queries for the parity heal — Neon conflicts/events for the
// stale item rows, the local outbox state of audit 6931, the dead event.
import { Database } from 'bun:sqlite'
import { Pool } from 'pg'
import { neonPooledUrl } from '../lib/env-local'

const db = new Database('db/custom.db', { readonly: true })
const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 1 })

const conf = (
  await pool.query(
    'SELECT id, "eventId", entity, "entityId", policy, resolution, details, "resolvedAt" FROM hybrid_conflicts WHERE entity = $1 AND "entityId" IN (2694,2697,2732) ORDER BY id',
    ['OrderItem'],
  )
).rows
console.log('Neon conflicts for items 2694/2697/2732:', conf.length)
for (const c of conf)
  console.log(
    '  ',
    JSON.stringify({ id: c.id, item: c.entityId, policy: c.policy, resolution: c.resolution, details: String(c.details ?? '').slice(0, 110) }),
  )

const ev = (
  await pool.query(
    'SELECT id, "eventId", entity, "entityId", operation, status, direction, "createdAt" FROM hybrid_events WHERE entity = $1 AND "entityId" IN (2694,2697,2732) ORDER BY id',
    ['OrderItem'],
  )
).rows
console.log('Neon event-log rows for items 2694/2697/2732:')
for (const e of ev) console.log('  ', JSON.stringify(e))

const o = db.query("SELECT eventId, entity, entityId, operation, status, createdAt FROM hybrid_events WHERE entity='AuditLog' AND entityId=6931").all()
console.log('local outbox events for audit 6931:', JSON.stringify(o))

const d = db.query("SELECT eventId, entity, entityId, operation, lastError, createdAt FROM hybrid_events WHERE status='dead'").all()
console.log('dead event:', JSON.stringify(d))

// how did audit rows normally get pushed? sample a recent acked AuditLog push
const sample = db
  .query("SELECT eventId, entity, entityId, operation, status, ackedAt FROM hybrid_events WHERE entity='AuditLog' AND direction='out' AND status='acked' ORDER BY id DESC LIMIT 3")
  .all()
console.log('recent acked AuditLog pushes (local):', JSON.stringify(sample))

await pool.end()
