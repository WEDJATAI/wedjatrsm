/**
 * Round 11 Phase A — Database housekeeping (guarded, audited)
 *
 * 1. Hard-delete EMPTY floor-plan artifacts (only when zero tables reference
 *    them — otherwise abort; floor plans with tables must never be touched).
 * 2. Backfill VisionTableState for zone-mapped tables that lack a state row,
 *    matching their siblings ('empty', human-confirmed post-outage baseline).
 * 3. Write an audit row documenting the housekeeping.
 *
 * Run: bun scripts/round11-cleanup.ts
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

const ARTIFACT_NAMES = ['main', '1', 'Lilo Cafe'] // empty test artifacts (Round 10 audit finding)

async function main() {
  console.log('════ Round 11 Phase A — guarded housekeeping ════')

  // ── 1. Empty floor-plan artifacts ─────────────────────────────────
  const plans = await db.floorPlan.findMany({ select: { id: true, name: true, active: true } })
  for (const name of ARTIFACT_NAMES) {
    const candidates = plans.filter((p) => p.name === name)
    if (candidates.length === 0) {
      console.log(`  '${name}': already gone`)
      continue
    }
    for (const plan of candidates) {
      const tableCount = await db.restaurantTable.count({ where: { floorPlanId: plan.id } })
      if (tableCount > 0) {
        console.log(`  '${name}' (id ${plan.id}): KEPT — has ${tableCount} tables (guard)`)
        continue
      }
      await db.floorPlan.delete({ where: { id: plan.id } })
      console.log(`  '${name}' (id ${plan.id}, active=${plan.active}): DELETED (0 tables, verified)`)
    }
  }

  // ── 2. Vision state backfill for zone-mapped tables ────────────────
  const zoneTables = await db.visionZone.findMany({
    where: { active: true, tableId: { not: null } },
    select: { tableId: true },
  })
  const mappedIds = [...new Set(zoneTables.map((z) => z.tableId!))]
  let backfilled = 0
  for (const tableId of mappedIds) {
    const exists = await db.visionTableState.findUnique({ where: { tableId } })
    if (!exists) {
      await db.visionTableState.create({
        data: {
          tableId,
          state: 'empty',
          peopleCount: 0,
          confidence: 1,
          stateSince: new Date(),
        },
      })
      backfilled++
      console.log(`  vision state backfilled: table ${tableId} → empty`)
    }
  }
  if (backfilled === 0) console.log('  vision states: all zone-mapped tables already covered')

  // ── 3. Audit row ──────────────────────────────────────────────────
  const remaining = await db.floorPlan.findMany({ select: { name: true, active: true }, orderBy: { id: 'asc' } })
  await db.auditLog.create({
    data: {
      userName: 'System (Round 11 housekeeping)',
      action: 'floorplan.cleanup',
      entity: 'settings',
      details: `Removed empty floor-plan artifacts (${ARTIFACT_NAMES.join(', ')}); backfilled ${backfilled} vision state row(s); remaining floors: ${remaining.map((f) => f.name + (f.active ? '' : ' (inactive)')).join(' · ')}`,
    },
  })
  console.log(`  audit row written (floorplan.cleanup)`)

  console.log(`\nfinal floor plans: ${JSON.stringify(remaining)}`)
  console.log('════ Phase A housekeeping: DONE ════')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
