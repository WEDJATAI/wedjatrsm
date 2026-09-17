// Round 17 — pre-migration baseline snapshot: per-table row counts saved to
// download/r17-baseline-counts.json. After db push, round17-verify compares
// every pre-existing table against this snapshot to prove zero data loss.
import { PrismaClient } from '@prisma/client'
import { writeFileSync } from 'node:fs'

const p = new PrismaClient()

async function main() {
  const rows = (await p.$queryRawUnsafe(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%' ORDER BY name",
  )) as { name: string }[]
  const counts: Record<string, number> = {}
  for (const t of rows) {
    const r = (await p.$queryRawUnsafe(`SELECT COUNT(*) as c FROM "${t.name}"`)) as { c: number | bigint }[]
    counts[t.name] = Number(r[0].c)
  }
  writeFileSync('download/r17-baseline-counts.json', JSON.stringify({ takenAt: new Date().toISOString(), counts }, null, 2))
  console.log(`tables: ${rows.length}`)
  console.log(JSON.stringify(counts, null, 2))
}

main().then(() => p.$disconnect())
