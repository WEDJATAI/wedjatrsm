/**
 * p21: Neon (PostgreSQL) DDL migration — FloorPlan floor geometry.
 *
 * Adds the 3 floor-geometry columns (width_units, height_units, floor_shape)
 * to the production Neon database so the owner's floor size & shape edits
 * (which ride the hybrid outbox from every terminal) apply cleanly on the
 * cloud. Idempotent — safe to re-run.
 *
 * Usage: bun scripts/p21-neon-floor-geometry.ts
 * (credentials via scripts/lib/env-local.ts → .env.deploy-local)
 */
import { PrismaClient as PgClient } from '../pgtmp-client'
import { neonPooledUrl } from './lib/env-local'

const DDL: string[] = [
  `ALTER TABLE "floor_plans" ADD COLUMN IF NOT EXISTS "width_units" DOUBLE PRECISION NOT NULL DEFAULT 100`,
  `ALTER TABLE "floor_plans" ADD COLUMN IF NOT EXISTS "height_units" DOUBLE PRECISION NOT NULL DEFAULT 100`,
  `ALTER TABLE "floor_plans" ADD COLUMN IF NOT EXISTS "floor_shape" TEXT NOT NULL DEFAULT 'rectangle'`,
]

async function main() {
  const url = neonPooledUrl()
  const pg = new PgClient({ datasources: { db: { url } } })
  try {
    for (const stmt of DDL) {
      await pg.$executeRawUnsafe(stmt)
      console.log('✓', stmt.slice(0, 80))
    }
    const rows = await pg.$queryRawUnsafe(
      `SELECT column_name, data_type, column_default FROM information_schema.columns WHERE table_name = 'floor_plans' ORDER BY ordinal_position`,
    ) as Array<{ column_name: string; data_type: string; column_default: string | null }>
    console.log('\nfloor_plans columns now:')
    for (const r of rows) console.log(`  ${r.column_name} · ${r.data_type} · default ${r.column_default}`)
  } finally {
    await pg.$disconnect()
  }
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
