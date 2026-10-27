/**
 * r65: one-off courtesy sync — copy the r65 per-plane payroll configuration
 * (hourlyRate/monthlySalary for the two rated staff + the latenessRules
 * AppSetting) from the local SQLite plane to Neon, so the cloud web app
 * computes the SAME payroll/deductions the local plane shows. Users and
 * app_settings are deliberately per-plane in the hybrid architecture
 * (passwords/PINs never ride sync); this aligns the business values only.
 *
 *   NEON_DATABASE_URL="postgresql://…" bun scripts/r65/sync-payroll-config.ts
 */
import { PrismaClient as PgClient } from '../../pgtmp-client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Database } from 'bun:sqlite'

async function main() {
  const url = process.env.NEON_DATABASE_URL
  if (!url) {
    console.error('[r65-sync] NEON_DATABASE_URL is required')
    process.exit(2)
  }
  const local = new Database('db/custom.db', { readonly: true })

  // 1. rates + salaries (by user id — same lineage on both planes)
  const users = local
    .query('SELECT id, name, hourly_rate, monthly_salary FROM users WHERE hourly_rate IS NOT NULL OR monthly_salary IS NOT NULL')
    .all() as Array<{ id: number; name: string; hourly_rate: number | null; monthly_salary: number | null }>
  console.log('[r65-sync] rated users on local:', JSON.stringify(users))

  // 2. lateness rules
  const rules = local.query("SELECT value FROM app_settings WHERE key = 'latenessRules'").get() as
    | { value: string }
    | undefined
  console.log('[r65-sync] latenessRules:', rules?.value ?? '(not set)')

  const prisma = new PgClient({ adapter: new PrismaPg({ connectionString: url }) })
  for (const u of users) {
    await prisma.$executeRawUnsafe(
      `UPDATE "users" SET "hourly_rate" = $1, "monthly_salary" = $2 WHERE "id" = $3`,
      u.hourly_rate,
      u.monthly_salary,
      u.id,
    )
    console.log(`  ✓ user #${u.id} (${u.name}): rate=${u.hourly_rate} salary=${u.monthly_salary}`)
  }
  if (rules) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "app_settings" ("key", "value") VALUES ('latenessRules', $1)
       ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value"`,
      rules.value,
    )
    console.log('  ✓ app_settings.latenessRules set')
  }
  await prisma.$disconnect()
  console.log('[r65-sync] DONE')
}

main().catch((err) => {
  console.error('[r65-sync] FAILED:', err)
  process.exit(1)
})
