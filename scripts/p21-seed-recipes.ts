/**
 * p21: SEED THE RECIPE BOOK — ingredients (with par stock) + recipes for the
 * full Lelo menu, through the hybrid-outbox contract so every write converges
 * to Neon/prod.
 *
 * SAFETY ORDER (matters — the restaurant is LIVE on prod):
 *   Phase 1  par stock + thresholds for the 19 EXISTING ingredients
 *            (ids 1-19 aligned on both sides) — stock events land on Neon
 *            BEFORE any recipe exists there, so the live stock check can
 *            never block when recipes arrive.
 *   Phase 2  ~74 NEW ingredients at EXPLICIT ids ≥ 230 (Neon's product id
 *            space ends at 229 — local autoincrement would collide and
 *            overwrite live prod rows; NEVER let it).
 *   Phase 3  recipe components for 157 dishes (upserts; dish ids 50-53 ride
 *            events with the p14 Neon remap 226-229; soft drinks intentionally
 *            have no recipes — unit items).
 *
 * Every business write + its outbox event commit in the SAME transaction
 * (the r30 atomicity contract). Run: bun scripts/p21-seed-recipes.ts
 */
import { db } from '../src/lib/db'
import { emitOutboxEvent } from '../src/lib/hybrid-sync/outbox'
import { NEW_INGREDIENTS, EXISTING_PARS, RECIPES, DISH_ID_REMAP } from './p21-data-recipes'

const round2 = (n: number) => Math.round(n * 100) / 100
const INGREDIENT_CATEGORY_ID = 6

async function main() {
  console.log('════ p21 recipe seed — preflight ════')
  const maxProduct = await db.product.aggregate({ _max: { id: true } })
  const products = await db.product.findMany({ select: { id: true, name: true, stock: true, lowStockThreshold: true, isStockable: true, isSellable: true, active: true } })
  const byName = new Map(products.map((p) => [p.name, p]))
  const maxRecipe = await db.recipeComponent.aggregate({ _max: { id: true } })
  console.log(`products: ${products.length} (max id ${maxProduct._max.id}) · recipe components: ${await db.recipeComponent.count()} (max id ${maxRecipe._max.id})`)

  if ((maxProduct._max.id ?? 0) >= 230) {
    const mine = products.filter((p) => p.id >= 230).length
    console.log(`p21 ingredients already present (≥230): ${mine} — resuming safely`)
  }

  // ── Phase 1: par stock + thresholds for existing ingredients ────────
  console.log('\n════ Phase 1: par stock for the 19 existing ingredients ════')
  let toppedUp = 0
  for (const [name, { par, low }] of Object.entries(EXISTING_PARS)) {
    const product = byName.get(name)
    if (!product || !product.isStockable) {
      console.warn(`  ! "${name}" not found / not stockable — SKIPPED`)
      continue
    }
    const delta = round2(par - product.stock)
    if (delta <= 0.01 && Math.abs(product.lowStockThreshold - low) < 0.001) {
      console.log(`  = ${name}: already at par (stock ${product.stock})`)
      continue
    }
    await db.$transaction(async (tx) => {
      const saved = await tx.product.update({
        where: { id: product.id },
        data: { stock: par, lowStockThreshold: low },
      })
      await emitOutboxEvent(tx, { entity: 'Product', entityId: saved.id, operation: 'update', row: saved })
      if (delta > 0.01) {
        const txRow = await tx.inventoryTransaction.create({
          data: { productId: product.id, quantityChange: delta, reason: 'purchase' },
        })
        await emitOutboxEvent(tx, { entity: 'InventoryTransaction', entityId: txRow.id, operation: 'create', row: txRow })
      }
    })
    toppedUp++
    console.log(`  + ${name}: stock ${product.stock} → ${par} (Δ${delta}) · low ${product.lowStockThreshold} → ${low}`)
  }
  console.log(`Phase 1 done: ${toppedUp} ingredients brought to par`)

  // ── Phase 2: create the new ingredient palette (explicit ids ≥ 230) ─
  console.log('\n════ Phase 2: new ingredient palette ════')
  let created = 0
  let nextId = Math.max(229, ...products.map((p) => p.id)) + 1
  for (const ing of NEW_INGREDIENTS) {
    const existing = byName.get(ing.name)
    if (existing) {
      console.log(`  = ${ing.name} already exists (id ${existing.id})`)
      continue
    }
    const id = nextId++
    await db.$transaction(async (tx) => {
      const row = await tx.product.create({
        data: {
          id,
          name: ing.name,
          nameAr: ing.nameAr,
          categoryId: INGREDIENT_CATEGORY_ID,
          price: 0,
          cost: ing.cost,
          isStockable: true,
          isSellable: false,
          active: true,
          lowStockThreshold: ing.low,
          stock: ing.par,
        },
      })
      await emitOutboxEvent(tx, { entity: 'Product', entityId: row.id, operation: 'create', row })
      const txRow = await tx.inventoryTransaction.create({
        data: { productId: id, quantityChange: ing.par, reason: 'purchase' },
      })
      await emitOutboxEvent(tx, { entity: 'InventoryTransaction', entityId: txRow.id, operation: 'create', row: txRow })
    })
    created++
    if (created <= 5 || created === NEW_INGREDIENTS.length) console.log(`  + id ${id}: ${ing.name} (par ${ing.par}, low ${ing.low})`)
  }
  console.log(`Phase 2 done: ${created} new ingredients (next free id ${nextId})`)

  // ── Phase 3: the recipe book ────────────────────────────────────────
  console.log('\n════ Phase 3: recipes for the full menu ════')
  // refresh product map (new ids now exist)
  const fresh = await db.product.findMany({ select: { id: true, name: true } })
  const idByName = new Map(fresh.map((p) => [p.name, p.id]))
  let dishesDone = 0
  let components = 0
  const problems: string[] = []

  for (const [dishIdStr, parts] of Object.entries(RECIPES)) {
    const dishId = Number(dishIdStr)
    const dish = fresh.find((p) => p.id === dishId)
    if (!dish) {
      problems.push(`dish ${dishId} not found — SKIPPED`)
      continue
    }
    const rows: Array<{ ingredientId: number; quantity: number; name: string }> = []
    for (const [ingName, qty] of parts) {
      const ingId = idByName.get(ingName)
      if (!ingId) {
        problems.push(`dish ${dishId} (${dish.name}): ingredient "${ingName}" missing — line SKIPPED`)
        continue
      }
      if (!(qty > 0)) {
        problems.push(`dish ${dishId}: bad qty for ${ingName} — SKIPPED`)
        continue
      }
      rows.push({ ingredientId: ingId, quantity: qty, name: ingName })
    }
    if (rows.length === 0) continue

    for (const r of rows) {
      await db.$transaction(async (tx) => {
        const existing = await tx.recipeComponent.findUnique({
          where: { productId_ingredientId: { productId: dishId, ingredientId: r.ingredientId } },
        })
        const row = existing
          ? await tx.recipeComponent.update({
              where: { id: existing.id },
              data: { quantity: r.quantity },
            })
          : await tx.recipeComponent.create({
              data: { productId: dishId, ingredientId: r.ingredientId, quantity: r.quantity },
            })
        // p14 id-remap contract: dishes 50-53 ride events under their NEON
        // ids so the cloud apply lands on the right rows (local keeps local ids)
        const eventRow = { ...row, productId: DISH_ID_REMAP[dishId] ?? dishId }
        await emitOutboxEvent(tx, {
          entity: 'RecipeComponent',
          entityId: row.id,
          operation: existing ? 'update' : 'create',
          row: eventRow,
        })
      })
      components++
    }
    dishesDone++
  }
  console.log(`Phase 3 done: ${dishesDone} dishes · ${components} recipe components`)
  if (problems.length > 0) {
    console.log('\nPROBLEMS:')
    problems.forEach((p) => console.log('  !', p))
  }

  // ── summary ─────────────────────────────────────────────────────────
  const totalRecipes = await db.recipeComponent.count()
  const sellable = await db.product.count({ where: { active: true, isSellable: true } })
  const withRecipes = await db.$queryRaw<any[]>`select count(distinct product_id) n from recipe_components`
  console.log(`\n════ SUMMARY ════`)
  console.log(`recipe components total: ${totalRecipes} · dishes covered: ${withRecipes[0]?.n}/${sellable} sellable`)
  console.log(`outbox: ${await db.hybridEvent.count({ where: { direction: 'out', status: 'pending' } })} pending (engine will drain to Neon)`)
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1) })
