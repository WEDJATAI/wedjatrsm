import { Pool } from 'pg'
import { neonPooledUrl } from '../lib/env-local'
import { db } from '../../src/lib/db'
const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })

console.log('══ PUSH VERIFICATION (local → Neon) ══')
const s = await pool.query("SELECT id, name, notes FROM suppliers WHERE name LIKE 'R38%'")
console.log('Neon supplier:', s.rows.length ? JSON.stringify(s.rows[0]) : 'NOT FOUND')
const supSeq = await pool.query(`SELECT last_value::int v FROM suppliers_id_seq`)
console.log('suppliers_id_seq:', supSeq.rows[0].v, '(≥1 = self-healed past the just-pushed id)')
const ev = await db.hybridEvent.findFirst({ where: { entity: 'Supplier' }, orderBy: { id: 'desc' } })
console.log('local outbox Supplier:', ev ? `${ev.status} ackedAt=${ev.ackedAt?.toISOString?.() ?? 'null'}` : 'NONE')

console.log('══ PULL VERIFICATION (Neon → local) ══')
const c20 = await db.customer.findUnique({ where: { id: 20 }, select: { id: true, name: true, notes: true } })
console.log('LOCAL customer 20:', c20 ? `${c20.name} (${JSON.stringify(c20.notes)})` : 'NOT FOUND')
const inEv = await db.hybridEvent.findFirst({ where: { direction: 'in', entity: 'Customer', entityId: 20 } })
console.log('local in-event Customer#20:', inEv ? inEv.status : 'NONE')
const cursor = await db.hybridSyncState.findUnique({ where: { key: 'pull.cursor' } })
const rem = await db.hybridSyncState.findUnique({ where: { key: 'pull.remaining' } })
const lp = await db.hybridSyncState.findUnique({ where: { key: 'lastPullAt' } })
const reach = await db.hybridSyncState.findUnique({ where: { key: 'cloud.reachable' } })
console.log('engine:', `cursor=${cursor?.value} remaining=${rem?.value} lastPull=${lp?.value} reachable=${reach?.value}`)
await pool.end()
await db.$disconnect()
