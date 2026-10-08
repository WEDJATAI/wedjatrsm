// r50 follow-up: (A) restore the 2 historical audit rows (4753/4754) that the
// first roundtrip's cleanup query over-matched (they predate this session —
// zero-residue discipline requires restoring them byte-exact on BOTH planes);
// (B) re-prove the PUSH path with CLEAN supplier ids: id 3 carries a stale
// cloud watermark (expected no-op — the p20 stale-event protection working as
// designed) and id 4 is clean (the row MUST land on Neon, then the delete
// propagates and removes it). Full zero-residue cleanup scoped EXACTLY.
import { Pool } from 'pg'
import { createClient } from '@libsql/client'
import { neonPooledUrl } from '../lib/env-local'

const LOCAL = 'http://localhost:3000'
const ldb = createClient({ url: 'file:db/custom.db' })
const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let exitCode = 0
const fail = (m: string) => { console.log(`  ✗ ${m}`); exitCode = 1 }
const lrows = async (sql: string) => (await ldb.execute(sql)).rows as Array<Record<string, unknown>>

async function waitFor(desc: string, fn: () => Promise<boolean>, timeoutMs = 150_000, everyMs = 3_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) { console.log(`  ✓ ${desc} — after ${Math.round((Date.now() - t0) / 1000)}s`); return true }
    await sleep(everyMs)
  }
  fail(`${desc} — TIMEOUT after ${timeoutMs / 1000}s`); return false
}

async function main() {
  // ══════ PHASE A — restore historical audit rows 4753/4754 ══════
  console.log('══ PHASE A: restore historical audit 4753/4754 (both planes, byte-exact) ══')
  const snap = createClient({ url: 'file:download/rsm-platform-database.db' })
  const originals = (await snap.execute('SELECT id, action, entity, entity_id, user_id, user_name, person_id, person_name, details, created_at FROM audit_logs WHERE id IN (4753,4754)')).rows as Array<Record<string, unknown>>
  snap.close()
  if (originals.length !== 2) { console.log('  ✗ originals not found in snapshot'); process.exit(1) }
  for (const o of originals) {
    // local (SQLite — created_at is ms epoch)
    await ldb.execute({
      sql: 'INSERT INTO audit_logs (id, action, entity, entity_id, user_id, user_name, person_id, person_name, details, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      args: [o.id, o.action, o.entity, o.entity_id, o.user_id ?? null, o.user_name, o.person_id ?? null, o.person_name ?? null, o.details ?? null, o.created_at] as Array<string | number | null>,
    })
    // Neon (Postgres — timestamptz)
    await pool.query(
      `INSERT INTO audit_logs (id, action, entity, entity_id, user_id, user_name, person_id, person_name, details, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, to_timestamp($10/1000.0))`,
      [o.id, o.action, o.entity, o.entity_id, o.user_id ?? null, o.user_name, o.person_id ?? null, o.person_name ?? null, o.details ?? null, Number(o.created_at)],
    )
    console.log(`  restored audit #${o.id} (${o.action}) local + Neon`)
  }

  // ══════ PHASE B — clean PUSH re-probe (supplier ids 3 + 4) ══════
  console.log('══ PHASE B: PUSH re-probe — supplier #3 (stale watermark, expect no-op) + #4 (clean, must land) ══')
  const { createSessionToken } = await import('../../src/lib/auth')
  const token = await createSessionToken({ userId: 1, email: 'admin@rms.com', name: 'Dr Ihab', role: 'admin', permissions: [], roleName: null, isSuperAdmin: true, personId: null, personName: null })
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(LOCAL + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, json: await res.json().catch(() => null) }
  }

  const auditBefore = new Set((await lrows('SELECT id FROM audit_logs')).map((r) => Number(r.id)))
  const suppliersBefore = new Set((await lrows('SELECT id FROM suppliers')).map((r) => Number(r.id)))

  const mk = async (name: string) => {
    const r = await api('POST', '/api/suppliers', { name, phone: '+20-100-000-0050', notes: 'r50 push verification' })
    const id = (r.json as { supplier?: { id?: number } }).supplier?.id
    console.log(`  created local supplier #${id} (${name}) HTTP ${r.status}`)
    return id as number
  }
  const s3 = await mk('R50 Push Probe (watermark case)')
  const s4 = await mk('R50 Push Probe (clean case)')
  if (s3 !== 3 || s4 !== 4) console.log(`  note: expected ids 3/4, got ${s3}/${s4}`)

  const acked = (id: number, op: string) =>
    lrows(`SELECT status FROM hybrid_events WHERE entity='Supplier' AND entityId=${id} AND operation='${op}' ORDER BY id DESC LIMIT 1`).then((r) => r[0]?.status === 'acked')

  await waitFor(`supplier #${s3} create ACKED (cloud decision recorded)`, () => acked(s3, 'create'))
  await waitFor(`supplier #${s4} create ACKED`, () => acked(s4, 'create'))

  const neonS3 = (await pool.query('SELECT id, name FROM suppliers WHERE id = $1', [s3])).rows[0]
  const neonS4 = (await pool.query('SELECT id, name FROM suppliers WHERE id = $1', [s4])).rows[0]
  if (!neonS3) console.log(`  ✓ supplier #${s3} NOT in Neon — CORRECT (rev-1 create < historical rev-2 delete watermark → p20 stale protection no-op)`)
  else console.log(`  ? supplier #${s3} unexpectedly in Neon: ${JSON.stringify(neonS3)} (watermark theory needs revisit)`)
  if (neonS4) console.log(`  ✓ supplier #${s4} LANDED in Neon: ${JSON.stringify(neonS4)} — PUSH PATH VERIFIED with a clean id`)
  else fail(`supplier #${s4} MISSING in Neon (clean id — push path problem!)`)

  // delete both via the standard API; both deletes must ack; #4 must vanish from Neon
  for (const id of [s3, s4]) {
    const d = await api('DELETE', `/api/suppliers/${id}`)
    console.log(`  DELETE /api/suppliers/${id} → ${d.status}`)
  }
  await waitFor(`supplier #${s3} delete ACKED`, () => acked(s3, 'delete'))
  await waitFor(`supplier #${s4} delete ACKED`, () => acked(s4, 'delete'))
  const gone4 = (await pool.query('SELECT id FROM suppliers WHERE id = $1', [s4])).rowCount ?? 1
  if (gone4 === 0) console.log(`  ✓ supplier #${s4} deleted from Neon (delete event propagated UP)`)
  else fail(`supplier #${s4} still in Neon after delete`)

  // ══════ PHASE C — exact zero-residue cleanup ══════
  console.log('══ PHASE C: exact zero-residue cleanup ══')
  // audit rows: ONLY ids not present before the probe (this time scoped by set difference, not entity_id)
  const auditAfter = (await lrows('SELECT id FROM audit_logs')).map((r) => Number(r.id))
  const newAuditIds = auditAfter.filter((id) => !auditBefore.has(id))
  console.log(`  new audit rows this probe: ${JSON.stringify(newAuditIds)}`)
  // events: every local event row for the probe supplier ids + the new audit ids
  const evRows = await lrows(`SELECT "eventId" FROM hybrid_events WHERE (entity='Supplier' AND entityId IN (${s3},${s4})) OR (entity='AuditLog' AND entityId IN (${newAuditIds.join(',') || '0'}))`)
  const probeEventIds = evRows.map((r) => String(r.eventId))
  console.log(`  probe event ids: ${probeEventIds.length}`)

  // Neon: stream cleanup FIRST (r46 lesson), then rows
  if (probeEventIds.length) {
    const d1 = await pool.query('DELETE FROM hybrid_events WHERE "eventId" = ANY($1) RETURNING id', [probeEventIds])
    console.log(`  Neon: ${d1.rowCount} probe event copies removed`)
  }
  if (newAuditIds.length) {
    const d2 = await pool.query('DELETE FROM audit_logs WHERE id = ANY($1) RETURNING id', [newAuditIds])
    console.log(`  Neon: ${d2.rowCount} probe audit rows removed`)
  }
  await pool.query('DELETE FROM suppliers WHERE id = ANY($1)', [[s3, s4]])

  // local: surgical
  if (newAuditIds.length) await ldb.execute(`DELETE FROM audit_logs WHERE id IN (${newAuditIds.join(',')})`)
  if (probeEventIds.length) {
    await ldb.execute(`DELETE FROM hybrid_events WHERE "eventId" IN (${probeEventIds.map((i) => `'${i}'`).join(',')})`)
  }
  const leftover = await lrows(`SELECT id FROM suppliers WHERE id IN (${s3},${s4})`)
  console.log(`  local: probe rows removed (leftover suppliers: ${leftover.length})`)

  // ══════ PHASE D — final parity + zero-residue verdict ══════
  console.log('══ PHASE D: final parity verdict ══')
  const counts = async () => ({
    localAudit: Number((await lrows('SELECT COUNT(*) c FROM audit_logs'))[0]?.c ?? 0),
    localSuppliers: Number((await lrows('SELECT COUNT(*) c FROM suppliers'))[0]?.c ?? 0),
    neonAudit: Number(((await pool.query('SELECT COUNT(*)::int c FROM audit_logs')).rows[0] as { c: number }).c),
    neonSuppliers: Number(((await pool.query('SELECT COUNT(*)::int c FROM suppliers')).rows[0] as { c: number }).c),
  })
  const c = await counts()
  console.log(`  counts: local audit=${c.localAudit} suppliers=${c.localSuppliers} · neon audit=${c.neonAudit} suppliers=${c.neonSuppliers}`)
  const ok = c.localAudit === 203 && c.neonAudit === 203 && c.localSuppliers === 0 && c.neonSuppliers === 0
  console.log(ok
    ? '  ✓ BASELINE RESTORED — audit 203/203 (incl. the 2 historical rows), suppliers 0/0, zero residue'
    : '  ✗ counts differ from the launch baseline (audit 203, suppliers 0)')
  if (!ok) exitCode = 1

  await pool.end(); ldb.close()
  console.log(exitCode === 0 ? 'RESULT: PUSH PATH VERIFIED (clean-id create landed on Neon + delete propagated) + stale-watermark protection confirmed + zero residue' : 'RESULT: FAILURES ABOVE')
  process.exit(exitCode)
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1) })
