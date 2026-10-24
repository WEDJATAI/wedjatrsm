/**
 * r65: Neon (PostgreSQL) DDL migration — salary deductions + monthly salary.
 *
 * Adds to the production Neon database:
 *   1. the `salary_deductions` table (manual payroll deductions, synced via
 *      rsm-hybrid/1 as the SalaryDeduction entity — revision-aware)
 *   2. the nullable `users.monthly_salary` column (salaried staff base)
 *   3. the two SalaryDeduction indexes
 *
 * Usage (from the project root):
 *   NEON_DATABASE_URL="postgresql://…@…neon.tech/neondb" \
 *     bun scripts/r65/neon-migrate.ts
 *
 * Modeled on scripts/hybrid-neon-migrate.ts:
 *   - the Postgres side uses the pgtmp client generated from
 *     prisma/schema.pgtmp.prisma into ./pgtmp-client
 *     (bunx prisma generate --schema prisma/schema.pgtmp.prisma);
 *   - every statement is idempotent (CREATE TABLE IF NOT EXISTS /
 *     ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS) — safe to re-run;
 *   - the DDL matches EXACTLY what `prisma db push` would create from
 *     prisma/schema.postgres.prisma (quoted camelCase columns, SERIAL ids,
 *     TIMESTAMP(3), DOUBLE PRECISION floats) so the Vercel deployment's
 *     regenerated client works against it unmodified.
 */

import { PrismaClient as PgClient } from '../../pgtmp-client'
import { PrismaPg } from '@prisma/adapter-pg'

// ─── idempotent DDL (mirrors prisma/schema.postgres.prisma) ──────────

const DDL_STATEMENTS: string[] = [
  // r65: manual salary deductions (payroll month 'YYYY-MM')
  `CREATE TABLE IF NOT EXISTS "salary_deductions" (
    "id" SERIAL PRIMARY KEY,
    "user_id" INTEGER NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    "period_month" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "reason" TEXT,
    "created_by_id" INTEGER REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS "salary_deductions_user_id_period_month_idx" ON "salary_deductions"("user_id", "period_month")`,
  `CREATE INDEX IF NOT EXISTS "salary_deductions_period_month_idx" ON "salary_deductions"("period_month")`,
  // r65: salaried staff monthly base (attendance-connected payroll)
  `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "monthly_salary" DOUBLE PRECISION`,
]

async function main() {
  const url = process.env.NEON_DATABASE_URL
  if (!url) {
    console.error('[r65-migrate] NEON_DATABASE_URL is required')
    process.exit(2)
  }
  const prisma = new PgClient({
    adapter: new PrismaPg({ connectionString: url }),
  })

  console.log('[r65-migrate] applying idempotent DDL to Neon…')
  for (const stmt of DDL_STATEMENTS) {
    const label = stmt.split('\n')[0].slice(0, 72)
    await prisma.$executeRawUnsafe(stmt)
    console.log('  ✓', label)
  }

  // safe verification: the new column + table exist and are queryable
  const tables = await prisma.$queryRawUnsafe(
    `SELECT table_name FROM information_schema.tables WHERE table_name IN ('salary_deductions')`,
  )
  const columns = await prisma.$queryRawUnsafe(
    `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'monthly_salary'`,
  )
  console.log('[r65-migrate] verification:', JSON.stringify({ tables, columns }))
  const count = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "salary_deductions"`)
  console.log('[r65-migrate] salary_deductions row count:', JSON.stringify(count))

  await prisma.$disconnect()
  console.log('[r65-migrate] DONE')
}

main().catch((err) => {
  console.error('[r65-migrate] FAILED:', err)
  process.exit(1)
})
