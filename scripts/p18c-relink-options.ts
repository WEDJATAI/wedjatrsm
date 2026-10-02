// p18c-relink-options: repair the orphaned option links found in the post-p18b
// harmony sweep. 13 of the 22 product↔group links sat on RETIRED demo products
// (the old demo menu), so the active Lelo menu never surfaced those options —
// e.g. the Salad Dressing group (Olive oil · Caesar · Ranch · Balsamic) was
// linked to retired #23 "Caesar Salad" while the active #78 "Chicken Caesar
// Salad" had NO dressing choice.
//
// Conservative orphan repair (zero menu invention — only groups whose product
// type has a DIRECT active successor get relinked):
//   · #7 Salad Dressing   → #78 Chicken Caesar Salad (direct successor)
//   · #5 Pizza Extras     → #130-137 all 8 active pizzas (group was created
//                           for pizza; Margarita succeeds retired Margherita)
//   · #6 Dessert Toppings → #138 Brownies, #139 Creamy Kunafa, #140 Cheese
//                           Cake, #141 Molten Ice Cream, #145 Ice Cream,
//                           #146 Um Ali (sauce/nut-friendly desserts only)
//   NOT relinked (no real-menu basis — would invent offerings): Juice Size
//   (Lelo juices are single-size), Spice Level, generic Add-ons, legacy
//   Coffee Size (superseded by per-product size groups).
//
// Sync mechanics (p18-established pattern): the link table has a composite PK
// and cannot ride the hybrid event contract (entity-policy note), so links are
// written in ONE local transaction AND directly on Neon with the same ids
// (verified: all 15 targets share ids on both sides; none in the p14 remap
// tables). Groups/modifiers are unchanged (already 15/15 + 47/47 in parity),
// so no outbox events are needed. Turso gets the links via the next
// turso-sync mirror.
//
// Usage: bun scripts/p18c-relink-options.ts
import { PrismaClient } from '@prisma/client'
import { readFileSync } from 'node:fs'
import { Client } from 'pg'

const prisma = new PrismaClient()

// [groupId, productIds] — every group below already exists, active, with
// active options on BOTH local and Neon (verified in the p18b sweep).
const RELINKS: Array<{ groupId: number; products: number[]; label: string }> = [
  { groupId: 7, products: [78], label: 'Salad Dressing → Chicken Caesar Salad' },
  { groupId: 5, products: [130, 131, 132, 133, 134, 135, 136, 137], label: 'Pizza Extras → 8 active pizzas' },
  { groupId: 6, products: [138, 139, 140, 141, 145, 146], label: 'Dessert Toppings → 6 sauce/nut-friendly desserts' },
]

async function main() {
  // ── 1) local transaction: create missing links only (idempotent) ──
  const localReport = await prisma.$transaction(async (tx) => {
    let created = 0
    for (const g of RELINKS) {
      const group = await tx.modifierGroup.findUnique({ where: { id: g.groupId } })
      if (!group?.active) throw new Error(`group ${g.groupId} missing/inactive locally`)
      for (const pid of g.products) {
        const product = await tx.product.findUnique({ where: { id: pid } })
        if (!product?.active) throw new Error(`product ${pid} missing/inactive locally`)
        const exists = await tx.productModifierGroup.findUnique({
          where: { productId_modifierGroupId: { productId: pid, modifierGroupId: g.groupId } },
        })
        if (!exists) {
          await tx.productModifierGroup.create({
            data: {
              product: { connect: { id: pid } },
              modifierGroup: { connect: { id: g.groupId } },
              sortOrder: g.groupId,
            },
          })
          created++
        }
      }
    }
    const total = await tx.productModifierGroup.count()
    return { created, total }
  })
  console.log('LOCAL LINKS:', JSON.stringify(localReport))

  // ── 2) Neon: same links, direct writes (composite PK — no event channel) ──
  const neonUrl = readFileSync('.env.deploy-local', 'utf8').match(/^NEON_DATABASE_URL=(.+)$/m)![1].trim()
  const pg = new Client({ connectionString: neonUrl, ssl: { rejectUnauthorized: false } })
  await pg.connect()
  let neonLinks = 0
  for (const g of RELINKS) {
    for (const pid of g.products) {
      const r = await pg.query(
        `INSERT INTO product_modifier_groups (product_id, modifier_group_id, sort_order)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [pid, g.groupId, g.groupId],
      )
      neonLinks += r.rowCount ?? 0
    }
  }
  const neonTotal = await pg.query('SELECT COUNT(*)::int c FROM product_modifier_groups')
  await pg.end()
  console.log('NEON LINKS inserted:', neonLinks, '| neon total:', neonTotal.rows[0].c)

  // ── 3) verify parity ──
  const localCount = await prisma.productModifierGroup.count()
  console.log(`VERIFY local=${localCount} neon=${neonTotal.rows[0].c} ${localCount === neonTotal.rows[0].c ? 'PARITY ✓' : 'MISMATCH ✗'}`)
  if (localCount !== neonTotal.rows[0].c) throw new Error('link parity broken')

  for (const g of RELINKS) console.log('  ·', g.label)
  await prisma.$disconnect()
  console.log('DONE — next: turso-sync mirror will carry the links to the replica.')
}

main().catch((err) => {
  console.error('FAILED:', err)
  process.exit(1)
})
