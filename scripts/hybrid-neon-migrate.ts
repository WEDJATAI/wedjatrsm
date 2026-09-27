/**
 * R30: Neon (PostgreSQL) DDL migration for the hybrid-sync tables.
 *
 * Adds the 4 `rsm-hybrid/1` LOCAL OPERATIONAL QUEUE tables
 * (hybrid_devices, hybrid_events, hybrid_conflicts, hybrid_sync_state) plus
 * the nullable Order.originDeviceId column to the production Neon database.
 *
 * Usage (from the project root — needs Neon credentials, which this sandbox
 * does NOT have, so the script is a DELIVERABLE that has NOT been executed;
 * run it at deploy time BEFORE pushing the r30 code):
 *   DATABASE_URL="postgresql://…@…neon.tech/neondb?sslmode=require" \
 *     bun scripts/hybrid-neon-migrate.ts
 *
 * How it works (modeled on scripts/migrate-neon.ts):
 *   - the Postgres side uses the pgtmp client generated from
 *     prisma/schema.pgtmp.prisma into ./pgtmp-client
 *     (bunx prisma generate --schema prisma/schema.pgtmp.prisma);
 *   - every statement is idempotent (CREATE TABLE IF NOT EXISTS /
 *     CREATE INDEX IF NOT EXISTS / ADD COLUMN IF NOT EXISTS) — safe to re-run;
 *   - the DDL matches EXACTLY what `prisma db push` would create from
 *     prisma/schema.postgres.prisma (quoted camelCase columns, TIMESTAMP(3),
 *     SERIAL ids) so the Vercel deployment's regenerated client works
 *     against it unmodified;
 *   - prints a safe summary (row counts before/after — hybrid tables are new,
 *     so before-counts prove whether this is a first run or a re-run) and
 *     exits non-zero on any failure.
 */

import { PrismaClient as PgClient } from '../pgtmp-client'

// ─── idempotent DDL (mirrors prisma/schema.postgres.prisma) ───────────

const DDL_STATEMENTS: string[] = [
  // HybridDevice — device registry (raw deviceKey NEVER stored; sha256 only)
  `CREATE TABLE IF NOT EXISTS "hybrid_devices" (
    "id" SERIAL PRIMARY KEY,
    "deviceId" TEXT NOT NULL UNIQUE,
    "installationId" TEXT NOT NULL UNIQUE,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL DEFAULT 'windows',
    "keyHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastSeenAt" TIMESTAMP(3),
    "lastPushAt" TIMESTAMP(3),
    "lastPullAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
  )`,
  // HybridEvent — durable outbox (direction 'out') + in-record ('in')
  `CREATE TABLE IF NOT EXISTS "hybrid_events" (
    "id" SERIAL PRIMARY KEY,
    "eventId" TEXT NOT NULL UNIQUE,
    "deviceId" TEXT NOT NULL,
    "batchId" TEXT,
    "entity" TEXT NOT NULL,
    "entityId" INTEGER NOT NULL,
    "operation" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "payloadHash" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'out',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "ackedAt" TIMESTAMP(3)
  )`,
  `CREATE INDEX IF NOT EXISTS "hybrid_events_status_nextAttemptAt_idx" ON "hybrid_events"("status", "nextAttemptAt")`,
  `CREATE INDEX IF NOT EXISTS "hybrid_events_entity_entityId_idx" ON "hybrid_events"("entity", "entityId")`,
  `CREATE INDEX IF NOT EXISTS "hybrid_events_direction_deviceId_idx" ON "hybrid_events"("direction", "deviceId")`,
  // HybridConflict — every non-silent policy decision, human-reviewable
  `CREATE TABLE IF NOT EXISTS "hybrid_conflicts" (
    "id" SERIAL PRIMARY KEY,
    "eventId" TEXT NOT NULL UNIQUE,
    "entity" TEXT NOT NULL,
    "entityId" INTEGER NOT NULL,
    "localHash" TEXT NOT NULL,
    "remoteHash" TEXT NOT NULL,
    "policy" TEXT NOT NULL,
    "resolution" TEXT NOT NULL,
    "details" TEXT,
    "resolvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  // HybridSyncState — engine kv (pull cursor, reachability, pause flag…)
  `CREATE TABLE IF NOT EXISTS "hybrid_sync_state" (
    "key" TEXT PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL
  )`,
  // Order.originDeviceId — origin-authority conflict policy on active orders
  `ALTER TABLE "orders" ADD COLUMN IF NOT EXISTS "origin_device_id" TEXT`,
]

const HYBRID_TABLES = ['hybrid_devices', 'hybrid_events', 'hybrid_conflicts', 'hybrid_sync_state'] as const

async function countRows(pg: PgClient, table: string): Promise<number> {
  const rows = await pg.$queryRawUnsafe<Array<{ n: bigint | number }>>(
    `SELECT COUNT(*)::int AS n FROM "${table}"`,
  )
  return Number(rows[0]?.n ?? 0)
}

async function main(): Promise<void> {
  const pgUrl = process.env.DATABASE_URL ?? ''
  if (!pgUrl.startsWith('postgres')) {
    throw new Error('DATABASE_URL must be the Neon PostgreSQL URL for this script')
  }

  const pg = new PgClient()
  const started = Date.now()
  try {
    // 1) row counts BEFORE (proves first-run vs re-run; hybrid tables are
    //    expected to be absent/empty on a first run)
    console.log('[hybrid-neon-migrate] row counts BEFORE:')
    const before: Record<string, number> = {}
    for (const table of HYBRID_TABLES) {
      try {
        before[table] = await countRows(pg, table)
      } catch {
        before[table] = -1 // table does not exist yet
      }
      console.log(`  ${table.padEnd(20)} ${before[table] < 0 ? '(missing)' : before[table]}`)
    }

    // 2) idempotent DDL — each statement is safe to re-run
    for (const stmt of DDL_STATEMENTS) {
      await pg.$executeRawUnsafe(stmt)
    }
    console.log(`[hybrid-neon-migrate] ${DDL_STATEMENTS.length} DDL statements applied (IF NOT EXISTS — idempotent)`)

    // 3) row counts AFTER + a sanity probe that every table/column is usable
    console.log('[hybrid-neon-migrate] row counts AFTER:')
    for (const table of HYBRID_TABLES) {
      const n = await countRows(pg, table)
      console.log(`  ${table.padEnd(20)} ${n}`)
      if (before[table] !== -1 && n !== before[table]) {
        // nothing in this script writes rows — a drift here means someone else
        // is writing concurrently; report it loudly but do not fail
        console.warn(`[hybrid-neon-migrate] WARNING: ${table} row count changed during migration (${before[table]} → ${n})`)
      }
    }
    const orderCol = await pg.$queryRawUnsafe<Array<{ n: bigint | number }>>(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
       WHERE table_name = 'orders' AND column_name = 'origin_device_id'`,
    )
    if (Number(orderCol[0]?.n ?? 0) !== 1) {
      throw new Error('orders.origin_device_id missing after migration')
    }
    console.log('[hybrid-neon-migrate] orders.origin_device_id present ✓')

    console.log(`[hybrid-neon-migrate] DONE in ${Date.now() - started}ms — hybrid schema ready on Neon`)
  } finally {
    await pg.$disconnect()
  }
}

main().catch((e) => {
  console.error('[hybrid-neon-migrate] FAILED:', e instanceof Error ? e.message : e)
  process.exit(1)
})
