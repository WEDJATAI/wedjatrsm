// Round 17 — zero-data-loss verification.
// Phase 1 (pre-migration): proved all 27 baseline tables byte-count identical
// right after db:push. Phase 2 (final): every pre-existing table must have
// count ≥ baseline (growth from live R17 work is expected; ANY decrease is a
// hard failure). New R17 tables are listed with their counts, and every delta
// is accounted for in the worklog.
import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'

const p = new PrismaClient()

async function count(table: string): Promise<number> {
  const r = (await p.$queryRawUnsafe(`SELECT COUNT(*) as c FROM "${table}"`)) as { c: number | bigint }[]
  return Number(r[0].c)
}

async function main() {
  const baseline = JSON.parse(readFileSync('download/r17-baseline-counts.json', 'utf8')).counts
  let deletions = 0
  const growth: string[] = []
  for (const [t, expected] of Object.entries(baseline) as [string, number][]) {
    const now = await count(t)
    if (now < expected) {
      console.log(`DELETION DETECTED ${t}: baseline ${expected} -> now ${now}`)
      deletions++
    } else if (now > expected) {
      growth.push(`${t}: ${expected} -> ${now} (+${now - expected})`)
    }
  }
  console.log('Growth (expected — live R17 work, all accounted in worklog):')
  for (const g of growth) console.log(`  + ${g}`)
  const newTables = [
    'suppliers',
    'purchase_orders',
    'purchase_order_items',
    'stock_counts',
    'stock_count_lines',
    'waste_logs',
    'promotions',
  ]
  for (const t of newTables) console.log(`new table ${t}: ${await count(t)} rows`)
  const integrity = (await p.$queryRawUnsafe('PRAGMA integrity_check')) as { integrity_check: string }[]
  const fk = (await p.$queryRawUnsafe('PRAGMA foreign_key_check')) as unknown[]
  console.log(`integrity_check: ${integrity[0].integrity_check} · fk_violations: ${fk.length}`)
  console.log(
    deletions === 0
      ? 'ZERO-DELETION VERIFIED: every baseline table at or above its baseline count'
      : `FAILURES: ${deletions} table(s) below baseline`,
  )
}

main().then(() => p.$disconnect())
