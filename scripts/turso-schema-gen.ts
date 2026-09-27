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

const statements = ddl
  .split(';')
  .map((s) => s.replace(/--.*$/gm, '').trim())
  .filter((s) => s.length > 0)
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
export const TURSO_DDL: string[] = [
`

const body = statements.map((s) => '  ' + JSON.stringify(s) + ',').join('\n')
writeFileSync('src/lib/turso-schema.ts', banner + body + '\n]\n')
console.log(`[turso-schema-gen] wrote ${statements.length} statements to src/lib/turso-schema.ts`)
