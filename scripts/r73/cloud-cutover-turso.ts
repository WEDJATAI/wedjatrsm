/**
 * R73 cloud cutover — Neon → Turso (one-time migration).
 *
 * CONTEXT: Neon PostgreSQL (the Vercel deployment's cloud primary since R23)
 * hit its free-tier compute quota on Oct 27 2026 — a HARD account-level
 * block (even `SELECT 1` is refused on pooled AND unpooled endpoints; the
 * quota resets monthly). Every DB-backed API on the cloud returned
 * {"error":"Internal server error"} while static pages still rendered.
 *
 * THE FIX: Turso (libsql — SQLite dialect over the wire) becomes the cloud
 * primary. It has been the analytics replica since r23 (kept current by the
 * daily replica pipeline), so business data is already ~in sync; the same
 * Prisma schema + @prisma/adapter-libsql drives it — one dialect everywhere.
 *
 * THIS SCRIPT (run LOCALLY, where DATABASE_URL=file:… so the replica engine
 * still runs — it no-ops on the cloud plane by design):
 *   1. verify the local system of record is the healthy restored r72-era db
 *   2. full business-data refresh  local → Turso  (syncAllToTurso: DELETE+
 *      INSERT per table, queue tables excluded, per-table count verify)
 *   3. create the 4 hybrid-sync queue tables on Turso (TURSO_HYBRID_QUEUE_DDL)
 *   4. seed the device registry (hybrid_devices incl. keyHashes — device
 *      identities survive the cutover, no re-pairing for the local terminal)
 *   5. seed the hybrid_events AUTOINCREMENT at R73_LEDGER_SEED so the fresh
 *      cloud ledger continues ABOVE every device's saved pull cursor from
 *      the Neon era (max known Neon ledger id 17919 + headroom) — pulling
 *      terminals see all post-cutover cloud events immediately, zero client
 *      changes
 *   6. final verification sweep (counts + sequence + devices)
 *
 * AFTER: set the Vercel env (DATABASE_URL → libsql://…, + GITHUB_TOKEN,
 * + GITHUB_REPO) and buildCommand (prisma generate --schema
 * prisma/schema.prisma — the sqlite dialect), then publish the commit.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient } from '@libsql/client'
import { syncAllToTurso } from '../../src/lib/turso-sync'
import { TURSO_HYBRID_QUEUE_DDL } from '../../src/lib/turso-schema'

/** Ledger autoincrement seed — safely above every saved device cursor from
 * the Neon era (local pull cursor was 17919; +2000 headroom for stragglers). */
const R73_LEDGER_SEED = 20000

const ROOT = resolve(import.meta.dir, '../..')

// ── vault: explicit, independent of .env state ─────────────────────────
function vaultGet(key: string): string {
  const raw = readFileSync(resolve(ROOT, '.git/env-vault.env'), 'utf8')
  const line = raw.split('\n').find((l) => l.startsWith(key + '='))
  return line ? line.slice(key.length + 1).trim() : ''
}

const TURSO_URL = vaultGet('TURSO_DATABASE_URL')
const TURSO_TOKEN = vaultGet('TURSO_AUTH_TOKEN')

function fail(msg: string): never {
  console.error('[r73-cutover] FAIL:', msg)
  process.exit(1)
}

if (!TURSO_URL || !TURSO_TOKEN) fail('TURSO_DATABASE_URL / TURSO_AUTH_TOKEN missing from the vault')

// ── 1. local system of record must be the healthy restored db ──────────
// audit_logs is a RANGE: it legitimately grows from system activity (the
// replica engine's own replication.tursoSync row, engine cycles …) — the
// floor proves the restored r72-era db (the Sep-15-era recycle victim had
// 643), the ceiling is a sanity band. Business tables are exact.
const expected: Array<{ table: string; exactly?: number; min?: number; max?: number }> = [
  { table: 'users', exactly: 7 },
  { table: 'orders', exactly: 57 },
  { table: 'payments', exactly: 55 },
  { table: 'audit_logs', min: 2155, max: 2200 },
  { table: 'products', exactly: 211 },
]
const local = createClient({ url: 'file:' + resolve(ROOT, 'db/custom.db') })
console.log('[r73-cutover] 1) local system-of-record health check')
for (const e of expected) {
  const r = await local.execute(`SELECT count(*) AS c FROM "${e.table}"`)
  const got = Number((r.rows[0] as { c: unknown }).c)
  const ok = e.exactly !== undefined ? got === e.exactly : got >= (e.min ?? 0) && got <= (e.max ?? Infinity)
  if (!ok) fail(`local ${e.table}=${got}, expected ${e.exactly !== undefined ? String(e.exactly) : `${e.min}..${e.max}`} — restore the r72-era db first (backups/auto/custom-20261027-164727.db)`)
  console.log(`   ✓ ${e.table}=${got}`)
}
await local.close()

// ── 2. full business-data refresh local → Turso ────────────────────────
console.log('[r73-cutover] 2) full business-data refresh local → Turso (replica engine)')
process.env.TURSO_DATABASE_URL = TURSO_URL
process.env.TURSO_AUTH_TOKEN = TURSO_TOKEN
const report = await syncAllToTurso()
if (!report.ok) fail(`replica refresh failed: ${report.error}`)
const badTables = report.tables.filter((t) => !t.ok)
if (badTables.length > 0) {
  for (const t of badTables) console.error(`   ✗ ${t.table}: source=${t.sourceRows} replica=${t.replicaRows}`)
  fail(`${badTables.length} table(s) out of parity`)
}
console.log(`   ✓ ${report.tables.length} tables in parity, ${report.totalRows} rows, ${report.durationMs}ms`)

// ── 3. hybrid queue tables on Turso ────────────────────────────────────
console.log('[r73-cutover] 3) creating hybrid-sync queue tables on Turso')
const turso = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN })
for (const ddl of TURSO_HYBRID_QUEUE_DDL) {
  await turso.execute(ddl)
}
console.log(`   ✓ ${TURSO_HYBRID_QUEUE_DDL.length} DDL statements applied (idempotent)`)

// ── 4. seed the device registry ────────────────────────────────────────
console.log('[r73-cutover] 4) seeding device registry (identities + keyHashes survive)')
const localDev = createClient({ url: 'file:' + resolve(ROOT, 'db/custom.db') })
const devRows = await localDev.execute('SELECT "id", "deviceId", "installationId", "name", "platform", "keyHash", "status", "lastSeenAt", "lastPushAt", "lastPullAt", "createdAt", "updatedAt" FROM hybrid_devices')
await localDev.close()
// fresh registry (idempotent re-run): wipe + reseed from the system of record
await turso.execute('DELETE FROM hybrid_devices')
for (const row of devRows.rows) {
  const d = row as Record<string, string | number | null>
  await turso.execute({
    sql: 'INSERT INTO hybrid_devices ("id", "deviceId", "installationId", "name", "platform", "keyHash", "status", "lastSeenAt", "lastPushAt", "lastPullAt", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    args: [d.id, d.deviceId, d.installationId, d.name, d.platform, d.keyHash, d.status, d.lastSeenAt, d.lastPushAt, d.lastPullAt, d.createdAt, d.updatedAt],
  })
}
console.log(`   ✓ ${devRows.rows.length} devices seeded (active: ${
  devRows.rows.filter((r) => (r as { status: string }).status === 'active').length
})`)

// ── 5. seed the ledger autoincrement above every Neon-era cursor ───────
console.log('[r73-cutover] 5) seeding hybrid_events AUTOINCREMENT at', R73_LEDGER_SEED)
// SAFETY: this is a ONE-TIME pre-go-live migration. If the cloud ledger
// already holds live events (post-go-live), wiping it would destroy sync
// history — abort unless explicitly forced.
const live = await turso.execute('SELECT count(*) AS c FROM hybrid_events')
const liveCount = Number((live.rows[0] as { c: unknown }).c)
if (liveCount > 0 && process.env.FORCE_R73_CUTOVER !== '1') {
  fail(`cloud ledger already holds ${liveCount} live event(s) — post-go-live re-run refused (set FORCE_R73_CUTOVER=1 to override)`)
}
await turso.execute('DELETE FROM hybrid_events') // fresh ledger (safe pre-go-live)
await turso.execute({
  sql: 'INSERT INTO hybrid_events ("id", "eventId", "deviceId", "entity", "entityId", "operation", "revision", "payloadHash", "payload", "direction", "status", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  args: [R73_LEDGER_SEED, 'r73-cutover-seed', 'r73-cutover', 'cutover', 0, 'seed', 1, 'r73', '{}', 'out', 'dead', new Date().toISOString()],
})
await turso.execute(`DELETE FROM hybrid_events WHERE id = ${R73_LEDGER_SEED}`)
const seq = await turso.execute("SELECT seq FROM sqlite_sequence WHERE name = 'hybrid_events'")
const seqVal = Number((seq.rows[0] as { seq: unknown } | undefined)?.seq ?? 0)
if (seqVal < R73_LEDGER_SEED) fail(`sqlite_sequence for hybrid_events is ${seqVal}, expected >= ${R73_LEDGER_SEED}`)
console.log(`   ✓ next cloud ledger id will be ${seqVal + 1} (all Neon-era cursors ≤ 17919 see every post-cutover event)`)

// ── 6. final verification sweep ────────────────────────────────────────
console.log('[r73-cutover] 6) final verification sweep')
const checkTables = ['users', 'orders', 'order_items', 'payments', 'audit_logs', 'products', 'cash_drawer_sessions', 'hybrid_devices']
const localCheck = createClient({ url: 'file:' + resolve(ROOT, 'db/custom.db') })
for (const t of checkTables) {
  const lr = await localCheck.execute(`SELECT count(*) AS c FROM "${t}"`)
  const tr = await turso.execute(`SELECT count(*) AS c FROM "${t}"`)
  const lc = Number((lr.rows[0] as { c: unknown }).c)
  let tc = Number((tr.rows[0] as { c: unknown }).c)
  // Known self-referential delta: the replica engine's OWN run writes a
  // `replication.tursoSync` audit row into the local db DURING step 2 —
  // after its snapshot was already copied. If that exact newest row is the
  // only delta, append it to Turso so parity is exact.
  if (t === 'audit_logs' && lc === tc + 1) {
    const newest = await localCheck.execute('SELECT "id", "user_id", "user_name", "person_id", "person_name", "action", "entity", "entity_id", "details", "created_at" FROM audit_logs ORDER BY id DESC LIMIT 1')
    const n = newest.rows[0] as Record<string, string | number | null> | undefined
    if (n && n.action === 'replication.tursoSync') {
      await turso.execute({
        sql: 'INSERT INTO audit_logs ("id", "user_id", "user_name", "person_id", "person_name", "action", "entity", "entity_id", "details", "created_at") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        args: [n.id, n.user_id, n.user_name, n.person_id, n.person_name, n.action, n.entity, n.entity_id, n.details, n.created_at],
      })
      const re = await turso.execute('SELECT count(*) AS c FROM audit_logs')
      tc = Number((re.rows[0] as { c: unknown }).c)
      console.log(`   ✓ appended the sync's own audit row #${n.id} (replication.tursoSync) to Turso`)
    }
  }
  const mark = lc === tc ? '✓' : '✗'
  console.log(`   ${mark} ${t}: local=${lc} turso=${tc}`)
  if (lc !== tc) fail(`${t} out of parity (local=${lc} turso=${tc})`)
}
await localCheck.close()
const evCount = await turso.execute('SELECT count(*) AS c FROM hybrid_events')
console.log(`   ✓ cloud ledger rows: ${Number((evCount.rows[0] as { c: unknown }).c)} (fresh — seeded sequence ${seqVal})`)
await turso.close()

console.log('\n[r73-cutover] TURSO IS READY AS THE CLOUD PRIMARY.')
console.log('NEXT: (a) Vercel env — DATABASE_URL → the Turso libsql URL on all targets, add GITHUB_TOKEN + GITHUB_REPO;')
console.log('      (b) Vercel buildCommand → prisma generate --schema prisma/schema.prisma && next build;')
console.log('      (c) publish the r73 commit → Vercel auto-deploys on the new plane.')
