/**
 * r42 two-way LIVE round-trip — the definitive "is the two-way sync working"
 * verification, exercised through the REAL paths:
 *
 *   PUSH  local HTTP API (POST /api/suppliers)  → outbox → engine push →
 *         Vercel cloud → Neon business table + ack
 *         then DELETE /api/suppliers/{id} → delete event → Neon row gone
 *   PULL  cloud-side write (Neon business row + hybrid_events, exactly what a
 *         Vercel-served write produces: deviceId 'unbound', direction 'out')
 *         → engine pull → applied locally
 *         then cloud-side delete → delete event → local row gone
 *
 * Create AND delete in BOTH directions = the full two-way surface. All probe
 * rows are removed by the test itself (no residue).
 */
import { randomUUID, createHash } from 'node:crypto'
import { Pool } from 'pg'
import { db } from '../../src/lib/db'
import { createSessionToken } from '../../src/lib/auth'
import { neonPooledUrl } from '../lib/env-local'

const LOCAL = 'http://localhost:3000'
const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(desc: string, fn: () => Promise<boolean>, timeoutMs = 120_000, everyMs = 3_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) {
      console.log(`  ✓ ${desc} — after ${Math.round((Date.now() - t0) / 1000)}s`)
      return true
    }
    await sleep(everyMs)
  }
  console.log(`  ✗ ${desc} — TIMEOUT after ${timeoutMs / 1000}s`)
  return false
}

async function main() {
  let exitCode = 0

  // ── session: mint a token server-side (login itself is not under test) ──
  const token = await createSessionToken({ userId: 1, email: 'admin@rms.com', name: 'Dr Ihab', role: 'admin', permissions: [], roleName: null, isSuperAdmin: true, personId: null, personName: null })
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(LOCAL + path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = await res.json().catch(() => null)
    return { status: res.status, json }
  }

  // ══════════════════ PHASE A — PUSH (local → cloud → Neon) ══════════════════
  console.log('══ PHASE A: PUSH (local API → engine → Vercel → Neon) ══')

  const created = await api('POST', '/api/suppliers', { name: 'R42 Sync Probe A', phone: '+20-100-000-0042', notes: 'r42 two-way live sync verification' })
  if (created.status !== 200 && created.status !== 201) {
    console.log('  ✗ supplier create failed:', created.status, JSON.stringify(created.json))
    await pool.end(); await db.$disconnect(); process.exit(1)
  }
  const supplierId = (created.json as { supplier?: { id?: number }, id?: number }).supplier?.id ?? (created.json as { id?: number }).id
  console.log(`  created local supplier #${supplierId} via POST /api/suppliers`)

  const pushCreateOk = await waitFor('outbox Supplier create ACKED by cloud', async () => {
    const ev = await db.hybridEvent.findFirst({ where: { entity: 'Supplier', entityId: supplierId, operation: 'create' }, orderBy: { id: 'desc' } })
    return ev?.status === 'acked'
  })
  if (!pushCreateOk) exitCode = 1

  const inNeon = await pool.query('SELECT id, name, notes FROM suppliers WHERE id = $1', [supplierId])
  console.log(inNeon.rows.length
    ? `  ✓ Neon has supplier #${supplierId}: ${JSON.stringify(inNeon.rows[0])}`
    : `  ✗ supplier #${supplierId} MISSING in Neon`)

  const del = await api('DELETE', `/api/suppliers/${supplierId}`)
  console.log(`  DELETE /api/suppliers/${supplierId} → ${del.status}`)
  const pushDeleteOk = await waitFor('outbox Supplier delete ACKED', async () => {
    const ev = await db.hybridEvent.findFirst({ where: { entity: 'Supplier', entityId: supplierId, operation: 'delete' }, orderBy: { id: 'desc' } })
    return ev?.status === 'acked'
  })
  if (!pushDeleteOk) exitCode = 1
  const goneNeon = await pool.query('SELECT id FROM suppliers WHERE id = $1', [supplierId])
  console.log(goneNeon.rows.length === 0
    ? '  ✓ supplier deleted from Neon (delete event propagated)'
    : `  ✗ supplier #${supplierId} STILL in Neon after delete`)

  // ══════════════════ PHASE B — PULL (Neon cloud write → local) ══════════════════
  console.log('══ PHASE B: PULL (cloud-side Neon write → engine pull → local apply) ══')

  // 1) cloud-side customer create — the exact shape a Vercel-served write produces
  const maxLocal = await db.customer.aggregate({ _max: { id: true } })
  const insCust = await pool.query(
    `INSERT INTO customers (name, phone, visits, points, total_spent, active, created_at)
     VALUES ('R42 Sync Probe B', '+20-100-000-0422', 0, 0, 0, true, now()) RETURNING id`,
  )
  const cloudCustomerId = insCust.rows[0].id as number
  console.log(`  cloud-side customer created in Neon: #${cloudCustomerId} (local max id = ${maxLocal._max.id ?? 'none'} — allocation above local max = collision-free)`)
  const custRow = (await pool.query('SELECT id, name, phone, visits, points, total_spent, last_visit_at, notes, active, created_at FROM customers WHERE id = $1', [cloudCustomerId])).rows[0]
  const toCamel = (r: Record<string, unknown>) => ({
    id: r.id, name: r.name, phone: r.phone, visits: r.visits, points: Number(r.points),
    totalSpent: Number(r.total_spent), lastVisitAt: r.last_visit_at, notes: r.notes,
    active: r.active, createdAt: r.created_at,
  })
  const payload = JSON.stringify(toCamel(custRow))
  const payloadHash = createHash('sha256').update(payload).digest('hex')
  await pool.query(
    `INSERT INTO hybrid_events ("eventId","deviceId","entity","entityId","operation","revision","payloadHash","payload","direction","status","attempts","createdAt","updatedAt")
     VALUES ($1,'unbound','Customer',$2,'create',1,$3,$4,'out','pending',0,now(),now())`,
    [randomUUID(), cloudCustomerId, payloadHash, payload],
  )
  console.log('  cloud event inserted (Customer create, deviceId=unbound — identical to a Vercel-served write)')

  const pullCreateOk = await waitFor(`local applied Customer#${cloudCustomerId}`, async () => {
    const ev = await db.hybridEvent.findFirst({ where: { direction: 'in', entity: 'Customer', entityId: cloudCustomerId, operation: 'create' }, orderBy: { id: 'desc' } })
    return ev?.status === 'applied'
  })
  if (!pullCreateOk) exitCode = 1
  const localCust = await db.customer.findUnique({ where: { id: cloudCustomerId } })
  console.log(localCust
    ? `  ✓ LOCAL has customer #${cloudCustomerId}: ${localCust.name} / ${localCust.phone} / notes=${JSON.stringify(localCust.notes)}`
    : `  ✗ customer #${cloudCustomerId} NOT applied locally`)

  // 2) cloud-side delete → must propagate down
  await pool.query('DELETE FROM customers WHERE id = $1', [cloudCustomerId])
  const delPayload = JSON.stringify({ id: cloudCustomerId })
  await pool.query(
    `INSERT INTO hybrid_events ("eventId","deviceId","entity","entityId","operation","revision","payloadHash","payload","direction","status","attempts","createdAt","updatedAt")
     VALUES ($1,'unbound','Customer',$2,'delete',2,$3,$4,'out','pending',0,now(),now())`,
    [randomUUID(), cloudCustomerId, createHash('sha256').update(delPayload).digest('hex'), delPayload],
  )
  console.log('  cloud-side delete issued (row + delete event)')

  const pullDeleteOk = await waitFor(`local applied Customer#${cloudCustomerId} DELETE`, async () => {
    const ev = await db.hybridEvent.findFirst({ where: { direction: 'in', entity: 'Customer', entityId: cloudCustomerId, operation: 'delete' }, orderBy: { id: 'desc' } })
    return ev?.status === 'applied'
  })
  if (!pullDeleteOk) exitCode = 1
  const localGone = await db.customer.findUnique({ where: { id: cloudCustomerId } })
  console.log(localGone === null
    ? '  ✓ customer deleted locally (cloud delete propagated down)'
    : `  ✗ customer #${cloudCustomerId} still present locally`)

  // ══════════════════ ENGINE FINAL STATE ══════════════════
  const cursor = await db.hybridSyncState.findUnique({ where: { key: 'pull.cursor' } })
  const rem = await db.hybridSyncState.findUnique({ where: { key: 'pull.remaining' } })
  const pend = await db.hybridEvent.count({ where: { direction: 'out', status: 'pending' } })
  const failed = await db.hybridEvent.count({ where: { status: 'failed' } })
  console.log(`══ ENGINE: cursor=${cursor?.value} remaining=${rem?.value} outbox-pending=${pend} failed=${failed} ══`)

  await pool.end()
  await db.$disconnect()
  process.exit(exitCode)
}

main().catch((e) => {
  console.error('FAIL:', e)
  process.exit(1)
})
