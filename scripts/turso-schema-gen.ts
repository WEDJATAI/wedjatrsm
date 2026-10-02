/**
 * R23: Regenerate src/lib/turso-schema.ts (the idempotent DDL embedded for
 * the Turso replica) after any prisma/schema.prisma model change.
 *
 *   bun scripts/turso-schema-gen.ts
 *
 * Pipeline: prisma migrate diff (SQLite dialect) → strip comments →
 * IF NOT EXISTS on every CREATE TABLE/INDEX → one-line statements →
 * emit as a TS string array (bundles cleanly into serverless).
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

// R30: hybrid-sync queue tables excluded from the replica. Kept in sync with
// HYBRID_QUEUE_TABLES in src/lib/turso-schema.ts (the runtime source of truth,
// emitted below). Inlined here — NOT imported — so regenerating never depends
// on the current contents of the file being rewritten (chicken-and-egg safe).
const HYBRID_QUEUE_TABLES = new Set([
  'hybrid_devices',
  'hybrid_events',
  'hybrid_conflicts',
  'hybrid_sync_state',
])

const ddl = execFileSync(
  'bunx',
  [
    'prisma',
    'migrate',
    'diff',
    '--from-empty',
    '--to-schema-datamodel',
    'prisma/schema.prisma',
    '--script',
  ],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
)

// R30: hybrid-sync queue tables are LOCAL OPERATIONAL STATE (outbox, in-record,
// device registry, engine kv) — they must never replicate to Turso, so their
// DDL is stripped here exactly like turso-sync.ts strips the tables themselves.
function statementTable(stmt: string): string | null {
  const table = /^CREATE TABLE (?:IF NOT EXISTS )?"([^"]+)"/.exec(stmt)
  if (table) return table[1]
  // index statements: CREATE [UNIQUE] INDEX [IF NOT EXISTS] "<idx>" ON "<table>"…
  const onTable = /^CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?"[^"]+" ON "([^"]+)"/.exec(stmt)
  if (onTable) return onTable[1]
  return null
}

const statements = ddl
  .split(';')
  .map((s) => s.replace(/--.*$/gm, '').trim())
  .filter((s) => s.length > 0)
  .filter((s) => {
    const table = statementTable(s)
    return !(table && HYBRID_QUEUE_TABLES.has(table))
  })
  .map((s) =>
    s
      .replace(/^CREATE TABLE /, 'CREATE TABLE IF NOT EXISTS ')
      .replace(/^CREATE UNIQUE INDEX /, 'CREATE UNIQUE INDEX IF NOT EXISTS ')
      .replace(/^CREATE INDEX /, 'CREATE INDEX IF NOT EXISTS ')
      .replace(/\s+/g, ' ')
      .trim(),
  )

const banner = `/**
 * R23: Turso (libsql/SQLite) replica schema — generated from prisma/schema.prisma
 * via: bunx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
 * then made idempotent (IF NOT EXISTS) and inlined as strings so it bundles
 * cleanly into the serverless deployment (no runtime file reads).
 *
 * The Turso database is the analytics/backup REPLICA of the system of record
 * (SQLite locally, Neon Postgres on Vercel). See src/lib/turso-sync.ts.
 *
 * REGENERATE after any prisma/schema.prisma model change:
 *   bun scripts/turso-schema-gen.ts
 */

/**
 * R30: hybrid-sync LOCAL OPERATIONAL QUEUES — per-installation state that must
 * NEVER replicate to the Turso replica. The replica is a full DELETE+INSERT
 * refresh; refreshing a queue table from the system of record would be wrong
 * on every level (an outbox is not a copy target — it is instance-local).
 * Applied by src/lib/turso-sync.ts (table walk) and this generator (DDL
 * generation) so the 4 hybrid tables never enter the replica at all.
 */
export const HYBRID_QUEUE_TABLES = new Set([
  'hybrid_devices',
  'hybrid_events',
  'hybrid_conflicts',
  'hybrid_sync_state',
])

export const TURSO_DDL: string[] = [
`

// R26/R30: column evolution for ALREADY-EXISTING replica tables — TURSO_DDL is
// CREATE TABLE IF NOT EXISTS, so new columns on existing tables need explicit
// ALTERs. Executed tolerantly by turso-sync (duplicate-column errors are fine).
// When regenerating, keep this list in sync with any new @map columns added to
// existing models (fresh databases get them via TURSO_DDL; live replicas via
// these ALTERs).
const migrations = `
/**
 * Column evolution for ALREADY-EXISTING replica tables — the DDL above
 * is CREATE TABLE IF NOT EXISTS, so new columns on existing tables need
 * explicit ALTERs. Executed tolerantly (duplicate-column errors are fine).
 */
export const TURSO_DDL_MIGRATIONS: string[] = [
  'ALTER TABLE "payments" ADD COLUMN "amount_tendered" REAL NOT NULL DEFAULT 0',
  'ALTER TABLE "payments" ADD COLUMN "change_given" REAL NOT NULL DEFAULT 0',
  // R27 (healed on replica here in R30): the one super-admin flag
  'ALTER TABLE "users" ADD COLUMN "is_super_admin" BOOLEAN NOT NULL DEFAULT false',
  // R30 hybrid sync: Order.originDeviceId (origin-authority conflict policy)
  'ALTER TABLE "orders" ADD COLUMN "origin_device_id" TEXT',
]
`

const body = statements.map((s) => '  ' + JSON.stringify(s) + ',').join('\n')
writeFileSync('src/lib/turso-schema.ts', banner + body + '\n]' + migrations)
console.log(`[turso-schema-gen] wrote ${statements.length} statements to src/lib/turso-schema.ts`)
