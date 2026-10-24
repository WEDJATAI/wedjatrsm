// r65: fresh recovery point (VACUUM INTO) + manifest — the r65 state:
// attendance-gated sign-in, developer-PIN gates, cancel-after-close,
// service-fee-free takeaway/delivery, attendance-connected payroll
// (days + monthly salaries) and the salary-deductions module.
import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, statSync, rmSync } from 'node:fs'

const db = new PrismaClient({ adapter: new PrismaLibSql({ url: (process.env.DATABASE_URL ?? 'file:./db/custom.db').split('?')[0] }) }) // r49: Prisma 7 adapter

async function main() {
  rmSync('download/rsm-platform-database.db', { force: true })
  await db.$queryRawUnsafe("VACUUM INTO 'download/rsm-platform-database.db'")
  const integ = await db.$queryRawUnsafe<{ integrity_check: string }[]>('PRAGMA integrity_check')
  const fk = await db.$queryRawUnsafe<Record<string, unknown>[]>('PRAGMA foreign_key_check')
  const counts: Record<string, number> = {}
  const tables = (
    await db.$queryRawUnsafe<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'",
    )
  ).map((t) => t.name)
  for (const t of tables) {
    const r = await db.$queryRawUnsafe<{ c: number }[]>(`SELECT COUNT(*) as c FROM "${t}"`)
    counts[t] = Number(r[0].c)
  }
  const sha = createHash('sha256').update(readFileSync('download/rsm-platform-database.db')).digest('hex')
  const manifest = {
    generatedAt: new Date().toISOString(),
    round: "R65 — service fee removed for takeaway/delivery · item removal + closed-check cancel by developer PIN · attendance a must before sign-in (staff) · salaries connected to attendance time and days · manager-controlled lateness rules + assignable deductions role · single-commit push to local, cloud and desktop (v2.6.0 artifacts)",
    database: {
      file: 'rsm-platform-database.db',
      bytes: statSync('download/rsm-platform-database.db').size,
      sha256: sha,
      engine: 'SQLite (WAL) — single embedded file',
      integrityCheck: integ[0].integrity_check,
      foreignKeyViolations: fk.length,
      tables: tables.length,
      rowCount: counts,
    },
  }
  writeFileSync('download/rsm-database-manifest.json', JSON.stringify(manifest, null, 2))
  console.log('recovery point:', JSON.stringify({ bytes: manifest.database.bytes, sha256: sha.slice(0, 12) + '…', integrity: integ[0].integrity_check, fkViolations: fk.length, salaryDeductions: counts['salary_deductions'], orders: counts['orders'], products: counts['products'] }))
  await db.$disconnect()
}
main()
