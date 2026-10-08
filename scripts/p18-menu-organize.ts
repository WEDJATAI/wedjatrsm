/**
 * p18-menu-organize — owner directive: smart menu analysis + reorganization.
 *
 * 1. CATEGORY CONSOLIDATION (24 active → 17):
 *    - Breakfast absorbs Omelet + Roll Pie (variant-merged, see below)
 *    - Appetizers & Sides = Appetizers + Fries
 *    - Sandwiches = Sandwiches + Cold Sandwiches
 *    - Main Dishes absorbs Vermicelli
 *    - Frappe, Smoothie & Yogurt = Frappe & Smoothie + Yogurt
 *    - Shisha (0 items, old residue) deactivated; emptied cats deactivated
 *    - display_order rewritten into the house flow:
 *      breakfast → sides → soups → salads → sandwiches → pans → pasta →
 *      mains → pizza → desserts → hot drinks → iced → frappe/yogurt →
 *      milkshake → juices → cocktails → soft drinks
 *
 * 2. VARIANT MERGE — "one icon, options inside" (the owner's omelet pattern):
 *    - Omelet: Cheesy(150)/Eyes(150)/Pastrami(180)/MixBeef(195) → ONE tile
 *      at 150 + Type group (Cheesy +0 · Eyes +0 · Pastrami +30 · Mix Beef +45)
 *      + Add-ons group (cheese/mushroom/pastrami/beef/veg)
 *    - Roll Pie: Sausage(210)/MixCheese(230)/MixBeef(230)/Kiri Pastrami(250)
 *      → ONE tile at 210 + Filling group
 *    - Turkish Coffee / Espresso / Mikato: Single+Double → ONE tile + Size group
 *    - Water: Small(20)/Large(30) → ONE tile + Size group
 *    - Frappuccino: Light(90)/Strong(95) → ONE tile + Strength group
 *    Variants are DEACTIVATED (never deleted — order history keeps rendering).
 *
 * 3. SYNC: every write rides the hybrid outbox (Product/Category/ModifierGroup/
 *    Modifier events) so the engine drains to prod (Neon). The link table
 *    product_modifier_groups is NOT event-addressable (composite PK) — links
 *    are written DIRECTLY on Neon with the p14 id remaps
 *    (local→neon products {50:226,51:227,52:228,53:229}; categories {9:29}).
 *
 * Idempotent by natural keys (group name, product sku); explicit ids for new
 * groups/modifiers so local and Neon agree.
 */
import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { Client } from 'pg'

const prisma = new PrismaClient({ adapter: new PrismaLibSql({ url: (process.env.DATABASE_URL ?? 'file:./db/custom.db').split('?')[0] }) }) // r49: Prisma 7 adapter
const DB_PATH = 'db/custom.db'

// local→neon id maps (p14 heritage — verified against Neon this session)
const PROD_REMAP: Record<number, number> = { 50: 226, 51: 227, 52: 228, 53: 229 }
const CAT_REMAP: Record<number, number> = { 9: 29 }
const pId = (localId: number) => PROD_REMAP[localId] ?? localId
const cId = (localId: number) => CAT_REMAP[localId] ?? localId

function fail(msg: string): never {
  console.error('ABORT — ' + msg)
  process.exit(1)
}

// ── 1) pre-write backup ────────────────────────────────────────────────────
const stamp = new Date()
const pad = (n: number) => String(n).padStart(2, '0')
const ts = `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`
{
  const bdb = new Database(DB_PATH)
  bdb.exec(`VACUUM INTO 'backups/pre-p18-menu-organize-${ts}.db'`)
  bdb.close()
  console.log('backup written: backups/pre-p18-menu-organize-' + ts + '.db')
}

// ── 2) preflight ───────────────────────────────────────────────────────────
const rdb = new Database(DB_PATH, { readonly: true })
const checks = {
  users: rdb.query('select count(*) c from users').get() as any,
  omelet: rdb.query("select id, name, price, active from products where id = 54").get() as any,
  cats: rdb.query('select count(*) c from categories where active = 1').get() as any,
  loItems: rdb.query("select count(*) c from products where sku like 'LO-%' and active = 1").get() as any,
  maxMg: rdb.query('select coalesce(max(id),0) c from modifier_groups').get() as any,
  maxMod: rdb.query('select coalesce(max(id),0) c from modifiers').get() as any,
  device: rdb.query("select value from hybrid_sync_state where key = 'local.deviceId'").get() as any,
  pendingOut: rdb.query("select count(*) c from hybrid_events where direction='out' and status='pending'").get() as any,
}
rdb.close()
if (checks.users.c !== 9) fail('expected 9 users, found ' + checks.users.c)
if (!checks.omelet || checks.omelet.name !== 'Cheesy Omelet') fail('product 54 is not Cheesy Omelet: ' + JSON.stringify(checks.omelet))
if (checks.cats.c !== 24) fail('expected 24 active categories, found ' + checks.cats.c)
if (checks.loItems.c !== 176) fail('expected 176 active LO items, found ' + checks.loItems.c)
if (checks.pendingOut.c !== 0) fail('outbox not drained (' + checks.pendingOut.c + ' pending)')
if (!checks.device?.value) fail('no local.deviceId')
console.log('preflight OK: 176 LO items · 24 active cats · max group id ' + checks.maxMg.c + ' · max modifier id ' + checks.maxMod.c)

// ── 3) the reorganization (single transaction: rows + outbox events) ──────
interface NewOption { name: string; nameAr: string; delta: number }
interface NewGroup {
  id: number
  name: string
  nameAr: string
  min: number
  max: number
  options: NewOption[]
  products: number[] // LOCAL product ids to link
}

// explicit ids: local max group id is 7, modifier max 25 → 8+, 26+
const GROUPS: NewGroup[] = [
  {
    id: 8, name: 'Omelet Type', nameAr: 'نوع الأومليت', min: 1, max: 1,
    options: [
      { name: 'Cheesy', nameAr: 'بالجبنة', delta: 0 },
      { name: 'Eyes Eggs', nameAr: 'بيض عيون', delta: 0 },
      { name: 'Pastrami', nameAr: 'باستيرامي', delta: 30 },
      { name: 'Mix Beef', nameAr: 'لحم مشكل', delta: 45 },
    ],
    products: [54],
  },
  {
    id: 9, name: 'Omelet Add-ons', nameAr: 'إضافات الأومليت', min: 0, max: 5,
    options: [
      { name: 'Extra Cheese', nameAr: 'جبنة إضافية', delta: 20 },
      { name: 'Extra Mushroom', nameAr: 'مشروم إضافي', delta: 15 },
      { name: 'Extra Pastrami', nameAr: 'باستيرامي إضافي', delta: 30 },
      { name: 'Extra Beef', nameAr: 'لحم إضافي', delta: 45 },
      { name: 'Extra Onion & Tomato', nameAr: 'بصل وطماطم إضافي', delta: 10 },
    ],
    products: [54],
  },
  {
    id: 10, name: 'Roll Pie Filling', nameAr: 'حشوة الرول باي', min: 1, max: 1,
    options: [
      { name: 'Sausage', nameAr: 'سجق', delta: 0 },
      { name: 'Mix Cheese', nameAr: 'جبنة مشكلة', delta: 20 },
      { name: 'Mix Beef', nameAr: 'لحم مشكل', delta: 20 },
      { name: 'Kiri Pastrami', nameAr: 'كيري باستيرامي', delta: 40 },
    ],
    products: [61],
  },
  {
    id: 11, name: 'Turkish Coffee Size', nameAr: 'حجم القهوة التركي', min: 1, max: 1,
    options: [
      { name: 'Single', nameAr: 'سنجل', delta: 0 },
      { name: 'Double', nameAr: 'دبل', delta: 10 },
    ],
    products: [169],
  },
  {
    id: 12, name: 'Espresso Size', nameAr: 'حجم الإسبريسو', min: 1, max: 1,
    options: [
      { name: 'Single', nameAr: 'سنجل', delta: 0 },
      { name: 'Double', nameAr: 'دبل', delta: 10 },
    ],
    products: [178],
  },
  {
    id: 13, name: 'Mikato Size', nameAr: 'حجم الميكاتو', min: 1, max: 1,
    options: [
      { name: 'Single', nameAr: 'سنجل', delta: 0 },
      { name: 'Double', nameAr: 'دبل', delta: 10 },
    ],
    products: [180],
  },
  {
    id: 14, name: 'Water Size', nameAr: 'حجم المياه', min: 1, max: 1,
    options: [
      { name: 'Small', nameAr: 'صغيرة', delta: 0 },
      { name: 'Large', nameAr: 'كبيرة', delta: 10 },
    ],
    products: [218],
  },
  {
    id: 15, name: 'Frappuccino Strength', nameAr: 'قوة الفرابيتشينو', min: 1, max: 1,
    options: [
      { name: 'Light', nameAr: 'خفيف', delta: 0 },
      { name: 'Strong', nameAr: 'قوي', delta: 5 },
    ],
    products: [193],
  },
]

// category moves: [localCatId, targetLocalCatId]
const MOVES: Array<[number, number]> = [
  [9, 7],    // Omelet → Breakfast
  [10, 7],   // Roll Pie Breakfast → Breakfast
  [8, 16],   // Cold Sandwiches → Sandwiches
  [12, 11],  // Fries → Appetizers (& Sides)
  [18, 19],  // Vermicelli → Main Dishes
  [28, 25],  // Yogurt → Frappe & Smoothie
]

// variants to deactivate (local product ids) — canonical survives
const DEACTIVATE = [55, 56, 57, 58, 59, 60, 170, 179, 181, 194, 219]

// canonical redefinitions: [id, name, nameAr, price, description]
const CANONICAL: Array<[number, string, string, number, string]> = [
  [54, 'Omelet', 'أومليت', 150, 'Fluffy omelet — pick your type (cheesy, eyes, pastrami, mix beef) and add-ons.'],
  [61, 'Roll Pie', 'رول باي', 210, 'Warm rolled pie — choose your filling: sausage, mix cheese, mix beef or Kiri pastrami.'],
  [169, 'Turkish Coffee', 'قهوة تركي', 45, 'Traditional Turkish coffee — single or double.'],
  [178, 'Espresso', 'إسبريسو', 45, 'Rich espresso shot — single or double.'],
  [180, 'Mikato', 'ميكاتو', 50, 'Signature Mikato — single or double.'],
  [193, 'Frappuccino', 'فرابيتشينو', 90, 'Iced frappuccino — light or strong.'],
  [218, 'Water', 'مياه', 20, 'Mineral water — small or large.'],
]

// final house-flow order (LOCAL ids; Breakfast=7 Appetizers=11 Soups=13
// Salads=14 Sandwiches=16 Pans=15 Pasta=17 Mains=19 Pizza=20 Desserts=3
// Hot=23 Iced=24 Frappe=25 Milkshake=22 Juices=21 Cocktails=26 Soft=27)
const FLOW: Array<[number, number, string | null, string | null]> = [
  // [localId, displayOrder, newName?, newNameAr?]
  [7, 10, null, null],
  [11, 20, 'Appetizers & Sides', 'المقبلات والإضافات'],
  [13, 30, null, null],
  [14, 40, null, null],
  [16, 50, null, null],
  [15, 60, null, null],
  [17, 70, null, null],
  [19, 80, null, null],
  [20, 90, null, null],
  [3, 100, null, null],
  [23, 110, null, null],
  [24, 120, null, null],
  [25, 130, 'Frappe, Smoothie & Yogurt', 'فرابيه وسموثي وزبادي'],
  [22, 140, null, null],
  [21, 150, null, null],
  [26, 160, null, null],
  [27, 170, null, null],
]
const DEACTIVATE_CATS = [5, 8, 9, 10, 12, 18, 28] // Shisha residue + emptied

// outbox emit — faithful mirror of src/lib/hybrid-sync/outbox.ts emitOutboxEvent
// (inlined: the app module transitively imports '@/lib/db' which the bun
// script runner cannot alias; the wire format is identical)
const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
function normalize(v: unknown): unknown {
  if (v === undefined || v === null) return null
  if (Array.isArray(v)) return v.map(normalize)
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[k]
      if (val === undefined) continue
      out[k] = normalize(val)
    }
    return out
  }
  return v
}
const canonicalJson = (v: unknown) => JSON.stringify(normalize(v))
function snapRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(row)) {
    out[field] = value instanceof Date ? value.toISOString() : value
  }
  return out
}
async function emit(tx: any, entity: string, entityId: number, operation: string, row: Record<string, unknown>) {
  const stateRow = await tx.hybridSyncState.findUnique({ where: { key: 'local.deviceId' } })
  const deviceId = stateRow?.value ?? 'unbound'
  // wire rows carry NEON ids (p14 contract): Category.id/Product.id/categoryId
  // are remapped; local cat 9 = neon 29, local products 50-53 = neon 226-229
  const wire = { ...snapRow(row) }
  if (entity === 'Category' && CAT_REMAP[Number(wire.id)]) wire.id = CAT_REMAP[Number(wire.id)]
  if (entity === 'Product') {
    if (PROD_REMAP[Number(wire.id)]) wire.id = PROD_REMAP[Number(wire.id)]
    if (CAT_REMAP[Number(wire.categoryId)]) wire.categoryId = CAT_REMAP[Number(wire.categoryId)]
  }
  const payload = canonicalJson(wire)
  const agg = await tx.hybridEvent.aggregate({ where: { entity, entityId }, _max: { revision: true } })
  const revision = (agg._max.revision ?? 0) + 1
  await tx.hybridEvent.create({
    data: {
      eventId: randomUUID(), deviceId, entity, entityId, operation, revision,
      payload, payloadHash: sha256Hex(payload),
      direction: 'out', status: 'pending',
    },
  })
}

const report = await prisma.$transaction(async (tx: any) => {
  let movedProducts = 0
  let deactivatedProducts = 0
  let canonicalUpdates = 0
  let catsDeactivated = 0
  let catsReordered = 0
  let groupsCreated = 0
  let modifiersCreated = 0
  let linksCreated = 0

  // 1. move products to consolidated categories
  for (const [from, to] of MOVES) {
    const r = await tx.product.updateMany({ where: { categoryId: from, active: true }, data: { categoryId: to } })
    movedProducts += r.count
  }

  // 2. deactivate variant products (emit per row)
  for (const id of DEACTIVATE) {
    const row = await tx.product.update({ where: { id }, data: { active: false } })
    await emit(tx, 'Product', pId(id), 'update', row)
    deactivatedProducts++
  }

  // 3. canonical redefinitions (rename + price + description)
  for (const [id, name, nameAr, price, description] of CANONICAL) {
    const row = await tx.product.update({ where: { id }, data: { name, nameAr, price, description } })
    await emit(tx, 'Product', pId(id), 'update', row)
    canonicalUpdates++
  }

  // 4. re-emit moved products (category change events, incl. canonicals)
  const movedIds = await tx.product.findMany({
    where: { active: true, categoryId: { in: [7, 11, 16, 19, 25] } },
    select: { id: true },
  })
  for (const { id } of movedIds) {
    const row = await tx.product.findUnique({ where: { id } })
    await emit(tx, 'Product', pId(id), 'update', row)
  }

  // 5. category renames + order
  for (const [id, order, name, nameAr] of FLOW) {
    const data: Record<string, unknown> = { displayOrder: order }
    if (name) Object.assign(data, { name })
    if (nameAr) Object.assign(data, { nameAr })
    const row = await tx.category.update({ where: { id }, data })
    await emit(tx, 'Category', cId(id), 'update', row)
    catsReordered++
  }

  // 6. deactivate emptied categories (+ Shisha residue)
  for (const id of DEACTIVATE_CATS) {
    const row = await tx.category.update({ where: { id }, data: { active: false } })
    await emit(tx, 'Category', cId(id), 'update', row)
    catsDeactivated++
  }

  // 7. modifier groups + options + links (explicit ids for neon parity)
  let modId = 26 // local max modifier id is 25
  for (const g of GROUPS) {
    const exists = await tx.modifierGroup.findUnique({ where: { id: g.id } })
    const row = exists
      ? await tx.modifierGroup.update({ where: { id: g.id }, data: { name: g.name, nameAr: g.nameAr, minSelect: g.min, maxSelect: g.max, active: true, sortOrder: g.id } })
      : await tx.modifierGroup.create({ data: { id: g.id, name: g.name, nameAr: g.nameAr, minSelect: g.min, maxSelect: g.max, active: true, sortOrder: g.id } })
    await emit(tx, 'ModifierGroup', g.id, exists ? 'update' : 'create', row)
    if (!exists) groupsCreated++

    for (const o of g.options) {
      const mExists = await tx.modifier.findUnique({ where: { id: modId } })
      const mRow = mExists
        ? await tx.modifier.update({ where: { id: modId }, data: { name: o.name, nameAr: o.nameAr, priceDelta: o.delta, active: true, sortOrder: modId } })
        : await tx.modifier.create({ data: { id: modId, groupId: g.id, name: o.name, nameAr: o.nameAr, priceDelta: o.delta, active: true, sortOrder: modId } })
      await emit(tx, 'Modifier', modId, mExists ? 'update' : 'create', mRow)
      if (!mExists) modifiersCreated++
      modId++
    }

    for (const pid of g.products) {
      const linkExists = await tx.productModifierGroup.findUnique({
        where: { productId_modifierGroupId: { productId: pid, modifierGroupId: g.id } },
      })
      if (!linkExists) {
        await tx.productModifierGroup.create({
          data: { product: { connect: { id: pid } }, modifierGroup: { connect: { id: g.id } }, sortOrder: g.id },
        })
        linksCreated++
      }
    }
  }

  return {
    movedProducts, deactivatedProducts, canonicalUpdates,
    catsDeactivated, catsReordered, groupsCreated, modifiersCreated, linksCreated,
    movedEvents: movedIds.length,
  }
})

console.log('LOCAL WRITES:', JSON.stringify(report))

// ── 4) Neon: direct link writes (product_modifier_groups, id-remapped) ────
const neonUrl = readFileSync('.env.deploy-local', 'utf8').match(/^NEON_DATABASE_URL=(.+)$/m)![1].trim()
const pg = new Client({ connectionString: neonUrl })
await pg.connect()
let neonLinks = 0
for (const g of GROUPS) {
  for (const pid of g.products) {
    const r = await pg.query(
      `INSERT INTO product_modifier_groups (product_id, modifier_group_id, sort_order)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [pId(pid), g.id, g.id],
    )
    neonLinks += r.rowCount ?? 0
  }
}
// verify the canonical products + categories landed the same intent (pre-events; events will land the rest)
const vCats = await pg.query('select count(*)::int c from categories where active = 1')
console.log('NEON LINKS inserted:', neonLinks, '(groups will land via events; neon active cats currently:', vCats.rows[0].c + ')')
await pg.end()

// ── 5) local post-verify ───────────────────────────────────────────────────
const vdb = new Database(DB_PATH, { readonly: true })
const v = {
  activeCats: (vdb.query('select count(*) c from categories where active = 1').get() as any).c,
  activeProducts: (vdb.query('select count(*) c from products where active = 1 and category_id != 6').get() as any).c,
  omeletTile: vdb.query("select p.name, p.price, p.active, (select count(*) from product_modifier_groups pmg where pmg.product_id = p.id) groups from products p where p.id = 54").get(),
  rollTile: vdb.query("select p.name, p.price, (select count(*) from product_modifier_groups pmg where pmg.product_id = p.id) groups from products p where p.id = 61").get(),
  variantsOff: (vdb.query('select count(*) c from products where id in (55,56,57,58,59,60,170,179,181,194,219) and active = 0').get() as any).c,
  breakfastItems: (vdb.query('select count(*) c from products where category_id = 7 and active = 1').get() as any).c,
  sandwiches: (vdb.query('select count(*) c from products where category_id = 16 and active = 1').get() as any).c,
  appetizersSides: (vdb.query('select count(*) c from products where category_id = 11 and active = 1').get() as any).c,
  frappeYogurt: (vdb.query('select count(*) c from products where category_id = 25 and active = 1').get() as any).c,
  mainDishes: (vdb.query('select count(*) c from products where category_id = 19 and active = 1').get() as any).c,
  flow: vdb.query('select group_concat(name, " → ") o from (select name from categories where active = 1 order by display_order)').get(),
  outbox: vdb.query("select status, count(*) c from hybrid_events where direction='out' group by status").all(),
}
vdb.close()
console.log('VERIFY active cats:', v.activeCats, '(expect 17)')
console.log('VERIFY active sellable products: (expect 165))')
console.log('VERIFY omelet tile:', JSON.stringify(v.omeletTile))
console.log('VERIFY roll pie tile:', JSON.stringify(v.rollTile))
console.log('VERIFY variants deactivated:', v.variantsOff, '/ 11')
console.log('VERIFY breakfast:', v.breakfastItems, '| sandwiches:', v.sandwiches, '| appetizers&sides:', v.appetizersSides, '| frappe/smoothie/yogurt:', v.frappeYogurt, '| mains:', v.mainDishes)
console.log('VERIFY tab flow:', (v.flow as any).o)
console.log('VERIFY outbox:', JSON.stringify(v.outbox))

if (v.activeCats !== 17) fail('expected 17 active categories, got ' + v.activeCats)
if (v.variantsOff !== 11) fail('expected 11 deactivated variants, got ' + v.variantsOff)
if (v.activeProducts !== 165) fail('expected 165 active sellable products, got ' + v.activeProducts)

await prisma.$disconnect()
console.log('DONE — engine will drain the outbox to prod; then trigger turso-sync.')
