// R47 closeout: fresh recovery point (VACUUM INTO) + manifest — the launch
// state includes the mazaj integration endpoints and the live shisha menu
// mirror (13 MAZAJ-* products).
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
    round: "R47 — 12th-recycle recovery to the r46 state, Inngest registration automated (v2 Cloud API), live E2E of the full mazaj→RSM loop (check #2190 verified + zero-residue cleaned), mazaj pending-sync self-healing deployed (b7bd67b)",
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
  console.log('recovery point:', JSON.stringify({ bytes: manifest.database.bytes, sha256: sha.slice(0, 12) + '…', integrity: integ[0].integrity_check, fkViolations: fk.length, orders: counts['orders'], products: counts['products'], audit: counts['audit_logs'] }))
  await db.$disconnect()
}
main()
