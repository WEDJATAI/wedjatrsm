// r50: definitive TWO-WAY LIVE sync round-trip (desktop/local ⇄ cloud) —
// adapted from the proven scripts/r42/roundtrip.ts pattern, extended with
// strict zero-residue cleanup (r46/r47 discipline) so the launch baseline
// counts are preserved EXACTLY.
//
//   PUSH  local HTTP API (POST /api/suppliers) → outbox → engine push →
//         Vercel cloud → Neon business table + ack
//         then DELETE /api/suppliers/{id} → delete event → Neon row gone
//   PULL  cloud-side write (Neon row + hybrid_events — exactly what a
//         Vercel-served write produces) → engine pull → applied locally
//         then cloud-side delete → delete event → local row gone
//   CLEAN every probe row + every probe event + every probe audit row is
//         removed from BOTH planes; final counts must equal the baseline.
import { randomUUID, createHash } from 'node:crypto'
import { Pool } from 'pg'
import { createClient } from '@libsql/client'
import { neonPooledUrl } from '../lib/env-local'

const LOCAL = 'http://localhost:3000'
const ldb = createClient({ url: 'file:db/custom.db' })
const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let exitCode = 0
const fail = (m: string) => { console.log(`  ✗ ${m}`); exitCode = 1 }

async function waitFor(desc: string, fn: () => Promise<boolean>, timeoutMs = 150_000, everyMs = 3_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) {
      console.log(`  ✓ ${desc} — after ${Math.round((Date.now() - t0) / 1000)}s`)
      return true
    }
    await sleep(everyMs)
  }
  fail(`${desc} — TIMEOUT after ${timeoutMs / 1000}s`)
  return false
}

const lrows = async (sql: string) => (await ldb.execute(sql)).rows as Array<Record<string, unknown>>

async function main() {
  // session token minted server-side (login flow itself is not under test)
  const { createSessionToken } = await import('../../src/lib/auth')
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

  // baseline (for the zero-residue verdict)
  const base = async () => ({
    localAudit: Number((await lrows('SELECT COUNT(*) c FROM audit_logs'))[0]?.c ?? 0),
    localAuditMax: Number((await lrows('SELECT COALESCE(MAX(id),0) m FROM audit_logs'))[0]?.m ?? 0),
    localSuppliers: Number((await lrows('SELECT COUNT(*) c FROM suppliers'))[0]?.c ?? 0),
    localCustomers: Number((await lrows('SELECT COUNT(*) c FROM customers'))[0]?.c ?? 0),
    neonAudit: Number(((await pool.query('SELECT COUNT(*)::int c FROM audit_logs')).rows[0] as { c: number }).c),
    neonSuppliers: Number(((await pool.query('SELECT COUNT(*)::int c FROM suppliers')).rows[0] as { c: number }).c),
    neonCustomers: Number(((await pool.query('SELECT COUNT(*)::int c FROM customers')).rows[0] as { c: number }).c),
  })
  const before = await base()
  console.log(`baseline: local audit=${before.localAudit} (max ${before.localAuditMax}) suppliers=${before.localSuppliers} customers=${before.localCustomers} · neon audit=${before.neonAudit} suppliers=${before.neonSuppliers} customers=${before.neonCustomers}`)

  // ══════════════════ PHASE A — PUSH (local API → engine → Vercel → Neon) ══════════════════
  console.log('══ PHASE A: PUSH (local API → engine → Vercel cloud → Neon) ══')

  const created = await api('POST', '/api/suppliers', { name: 'R50 Sync Probe A', phone: '+20-100-000-0050', notes: 'r50 two-way live sync verification' })
  if (created.status !== 200 && created.status !== 201) {
    console.log('  ✗ supplier create failed:', created.status, JSON.stringify(created.json))
    await pool.end(); ldb.close(); process.exit(1)
  }
  const supplierId = (created.json as { supplier?: { id?: number }, id?: number }).supplier?.id ?? (created.json as { id?: number }).id
  console.log(`  created local supplier #${supplierId} via POST /api/suppliers (HTTP ${created.status})`)

  const evStatus = async (where: string) => (await lrows(`SELECT status FROM hybrid_events ${where} ORDER BY id DESC LIMIT 1`))[0]?.status
  const pushCreateOk = await waitFor('outbox Supplier create ACKED by cloud', () =>
    evStatus(`WHERE entity='Supplier' AND entityId=${supplierId} AND operation='create'`).then((s) => s === 'acked'))
  if (!pushCreateOk) exitCode = 1

  const inNeon = (await pool.query('SELECT id, name FROM suppliers WHERE id = $1', [supplierId])).rows[0]
  if (inNeon) console.log(`  ✓ Neon has supplier #${supplierId}: ${JSON.stringify(inNeon)}`)
  else fail(`supplier #${supplierId} MISSING in Neon`)

  const del = await api('DELETE', `/api/suppliers/${supplierId}`)
  console.log(`  DELETE /api/suppliers/${supplierId} → ${del.status}`)
  const pushDeleteOk = await waitFor('outbox Supplier delete ACKED', () =>
    evStatus(`WHERE entity='Supplier' AND entityId=${supplierId} AND operation='delete'`).then((s) => s === 'acked'))
  if (!pushDeleteOk) exitCode = 1
  const goneNeon = (await pool.query('SELECT id FROM suppliers WHERE id = $1', [supplierId])).rowCount ?? 1
  if (goneNeon === 0) console.log('  ✓ supplier deleted from Neon (delete event propagated UP)')
  else fail(`supplier #${supplierId} STILL in Neon after delete`)

  // ══════════════════ PHASE B — PULL (Neon cloud write → engine pull → local apply) ══════════════════
  console.log('══ PHASE B: PULL (cloud-side Neon write → engine pull → local apply) ══')

  // cloud-side customer create — the exact shape a Vercel-served write produces
  const localMaxCust = Number((await lrows('SELECT COALESCE(MAX(id),0) m FROM customers'))[0]?.m ?? 0)
  const insCust = await pool.query(
    `INSERT INTO customers (name, phone, visits, points, total_spent, active, created_at)
     VALUES ('R50 Sync Probe B', '+20-100-000-0050', 0, 0, 0, true, now()) RETURNING id`,
  )
  const cloudCustomerId = insCust.rows[0].id as number
  console.log(`  cloud-side customer created in Neon: #${cloudCustomerId} (local max id = ${localMaxCust} — collision-free allocation)`)
  const custRow = (await pool.query('SELECT id, name, phone, visits, points, total_spent, last_visit_at, notes, active, created_at FROM customers WHERE id = $1', [cloudCustomerId])).rows[0] as Record<string, unknown>
  const toCamel = (r: Record<string, unknown>) => ({
    id: r.id, name: r.name, phone: r.phone, visits: r.visits, points: Number(r.points),
    totalSpent: Number(r.total_spent), lastVisitAt: r.last_visit_at, notes: r.notes,
    active: r.active, createdAt: r.created_at,
  })
  const custPayload = JSON.stringify(toCamel(custRow))
  const custCreateEventId = randomUUID()
  await pool.query(
    `INSERT INTO hybrid_events ("eventId","deviceId","entity","entityId","operation","revision","payloadHash","payload","direction","status","attempts","createdAt","updatedAt")
     VALUES ($1,'unbound','Customer',$2,'create',1,$3,$4,'out','pending',0,now(),now())`,
    [custCreateEventId, cloudCustomerId, createHash('sha256').update(custPayload).digest('hex'), custPayload],
  )
  console.log('  cloud event inserted (Customer create, deviceId=unbound — identical to a Vercel-served write)')

  const pullCreateOk = await waitFor(`local applied Customer#${cloudCustomerId} create`, () =>
    evStatus(`WHERE direction='in' AND entity='Customer' AND entityId=${cloudCustomerId} AND operation='create'`).then((s) => s === 'applied'))
  if (!pullCreateOk) exitCode = 1
  const localCust = (await lrows(`SELECT name, phone FROM customers WHERE id=${cloudCustomerId}`))[0]
  if (localCust) console.log(`  ✓ LOCAL has customer #${cloudCustomerId}: ${JSON.stringify(localCust)} (pulled from cloud)`)
  else fail(`customer #${cloudCustomerId} NOT applied locally`)

  // cloud-side delete → must propagate down
  await pool.query('DELETE FROM customers WHERE id = $1', [cloudCustomerId])
  const delPayload = JSON.stringify({ id: cloudCustomerId })
  const custDeleteEventId = randomUUID()
  await pool.query(
    `INSERT INTO hybrid_events ("eventId","deviceId","entity","entityId","operation","revision","payloadHash","payload","direction","status","attempts","createdAt","updatedAt")
     VALUES ($1,'unbound','Customer',$2,'delete',2,$3,$4,'out','pending',0,now(),now())`,
    [custDeleteEventId, cloudCustomerId, createHash('sha256').update(delPayload).digest('hex'), delPayload],
  )
  console.log('  cloud-side delete issued (row + delete event rev2)')

  const pullDeleteOk = await waitFor(`local applied Customer#${cloudCustomerId} DELETE`, () =>
    evStatus(`WHERE direction='in' AND entity='Customer' AND entityId=${cloudCustomerId} AND operation='delete'`).then((s) => s === 'applied'))
  if (!pullDeleteOk) exitCode = 1
  const localGone = (await lrows(`SELECT id FROM customers WHERE id=${cloudCustomerId}`)).length
  if (localGone === 0) console.log('  ✓ customer deleted locally (cloud delete propagated DOWN)')
  else fail(`customer #${cloudCustomerId} still present locally`)

  // ══════════════════ PHASE C — ZERO-RESIDUE CLEANUP (r47 discipline) ══════════════════
  console.log('══ PHASE C: zero-residue cleanup (probe events + audit rows, BOTH planes) ══')

  // 1. collect every probe eventId (local out rows for Supplier+AuditLog probes;
  //    local in rows for the Customer probe share the eventIds created above)
  const probeAuditIds = (await lrows(`SELECT id FROM audit_logs WHERE entity='supplier' AND entity_id=${supplierId} ORDER BY id`)).map((r) => Number(r.id))
  console.log(`  probe audit rows (supplier.create/delete): ${JSON.stringify(probeAuditIds)}`)
  const idList = (ids: string[]) => ids.map((i) => `'${i}'`).join(',')
  const outEvents = await lrows(`SELECT "eventId" FROM hybrid_events WHERE (entity='Supplier' AND entityId=${supplierId}) OR (entity='AuditLog' AND entityId IN (${probeAuditIds.join(',') || '0'}))`)
  const probeEventIds = [...outEvents.map((r) => String(r.eventId)), custCreateEventId, custDeleteEventId]
  console.log(`  probe events collected: ${probeEventIds.length} (${outEvents.length} out + 2 cloud-origin customer events)`)

  // 2. Neon: delete probe audit rows, probe event copies (in + out), any leftover probe business rows
  const neonAuditDel = await pool.query(`DELETE FROM audit_logs WHERE entity='supplier' AND entity_id=$1 RETURNING id`, [supplierId])
  console.log(`  Neon: ${neonAuditDel.rowCount} probe audit row(s) removed`)
  const neonEvDel = await pool.query(`DELETE FROM hybrid_events WHERE "eventId" = ANY($1) RETURNING id`, [probeEventIds])
  console.log(`  Neon: ${neonEvDel.rowCount} probe event row(s) removed (stream cleanup FIRST — r46 lesson)`)
  // safety net: any straggler probe rows
  await pool.query('DELETE FROM suppliers WHERE id = $1', [supplierId])
  await pool.query('DELETE FROM customers WHERE id = $1', [cloudCustomerId])

  // 3. local: surgical removal of the probe audit rows + all local event copies
  await ldb.execute(`DELETE FROM audit_logs WHERE entity='supplier' AND entity_id=${supplierId}`)
  const localEvDel = await ldb.execute(`DELETE FROM hybrid_events WHERE "eventId" IN (${idList(probeEventIds)})`)
  console.log(`  local: audit rows removed surgically (append-only policy — r47 pattern), ${localEvDel.rows.length ?? '?'} event copies deleted`)

  // ══════════════════ PHASE D — ENGINE FINAL STATE + ZERO-RESIDUE VERDICT ══════════════════
  console.log('══ PHASE D: engine final state + zero-residue verdict ══')
  const cursor = (await lrows("SELECT value FROM hybrid_sync_state WHERE key='pull.cursor'"))[0]
  const pend = Number((await lrows("SELECT COUNT(*) c FROM hybrid_events WHERE direction='out' AND status='pending'"))[0]?.c ?? 0)
  const dead = Number((await lrows("SELECT COUNT(*) c FROM hybrid_events WHERE status='dead'"))[0]?.c ?? 0)
  const neonMax = Number(((await pool.query('SELECT COALESCE(MAX(id),0) m FROM hybrid_events')).rows[0] as { m: number }).m)
  console.log(`  engine: cursor=${cursor?.value} · outbox-pending=${pend} · dead=${dead} (1 dead = the documented pre-r38 event)`)
  console.log(`  stream head: Neon max event id=${neonMax} vs cursor=${cursor?.value}`)

  const after = await base()
  const residue: string[] = []
  if (after.localAudit !== before.localAudit) residue.push(`local audit ${before.localAudit}→${after.localAudit}`)
  if (after.localAuditMax > before.localAuditMax) residue.push(`local audit max ${before.localAuditMax}→${after.localAuditMax}`)
  if (after.localSuppliers !== before.localSuppliers) residue.push(`local suppliers ${before.localSuppliers}→${after.localSuppliers}`)
  if (after.localCustomers !== before.localCustomers) residue.push(`local customers ${before.localCustomers}→${after.localCustomers}`)
  if (after.neonAudit !== before.neonAudit) residue.push(`neon audit ${before.neonAudit}→${after.neonAudit}`)
  if (after.neonSuppliers !== before.neonSuppliers) residue.push(`neon suppliers ${before.neonSuppliers}→${after.neonSuppliers}`)
  if (after.neonCustomers !== before.neonCustomers) residue.push(`neon customers ${before.neonCustomers}→${after.neonCustomers}`)
  console.log(residue.length === 0
    ? '  ✓ ZERO RESIDUE — every count back to the exact baseline'
    : `  ✗ RESIDUE: ${residue.join(' · ')}`)
  if (residue.length) exitCode = 1

  await pool.end()
  ldb.close()
  console.log(exitCode === 0 ? 'RESULT: TWO-WAY SYNC VERIFIED (push UP + pull DOWN, zero residue)' : 'RESULT: FAILURES ABOVE')
  process.exit(exitCode)
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1) })
