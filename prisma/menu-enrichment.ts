/**
 * R28 — menu enrichment restore (allergen/dietary tags, Garlic Bread,
 * modifier groups + links).
 *
 * WHY THIS EXISTS: these R8 fixtures originally lived only in the live DB
 * (added round-by-round, preserved by snapshots). The R27 full re-seed
 * rebuilt the database from seed.ts — which never carried them — so the
 * menu regressed to bare name/price cards: no Gluten/Dairy chips, no
 * Options pills, no "Double +EGP 15.00" lines, and Garlic Bread vanished
 * from the starters. This module re-applies the fixtures and is now wired
 * INTO seed.ts so future reseeds can never lose them again.
 *
 * Data source: the r23c recovery-point snapshot (35 tables, 1,640 rows —
 * the last snapshot with the complete R8 enrichment), verified against
 * the reference POS screenshot.
 *
 * Idempotent: safe to re-run on any DB (upserts / skip-if-present).
 * Standalone: `bun prisma/menu-enrichment.ts` applies to the live DB.
 * Seeded:    seed.ts calls enrichMenu(db) after creating products.
 */
import { PrismaClient } from '@prisma/client'

/** Allergen + dietary tags per sellable product (from the r23c snapshot). */
const ALLERGEN_DIETARY: Record<string, { allergens: string[]; dietary: string[] }> = {
  'Hummus with Olive Oil': { allergens: ['sesame'], dietary: ['vegetarian', 'vegan'] },
  'Falafel Plate (6 pcs)': { allergens: ['sesame'], dietary: ['vegetarian', 'vegan'] },
  'Cream of Tomato Soup': { allergens: ['dairy'], dietary: ['vegetarian'] },
  'Caesar Salad': { allergens: ['gluten', 'dairy', 'eggs', 'fish'], dietary: [] },
  'Garlic Bread': { allergens: ['gluten', 'dairy'], dietary: ['vegetarian'] },
  'Koshari (Classic)': { allergens: ['gluten'], dietary: ['vegetarian', 'vegan'] },
  'Grilled Chicken Quarter': { allergens: [], dietary: ['halal'] },
  'Beef Tagine': { allergens: [], dietary: ['halal', 'spicy'] },
  'Pasta Alfredo with Chicken': { allergens: ['gluten', 'dairy', 'eggs'], dietary: ['halal'] },
  'Grilled Tilapia Fillet': { allergens: ['fish'], dietary: ['halal'] },
  'Margherita Pizza': { allergens: ['gluten', 'dairy'], dietary: ['vegetarian'] },
  Basbousa: { allergens: ['gluten', 'dairy', 'eggs', 'nuts'], dietary: ['vegetarian'] },
  'Chocolate Lava Cake': { allergens: ['gluten', 'dairy', 'eggs', 'nuts'], dietary: ['vegetarian'] },
  'Rice Pudding (Mahalabia)': { allergens: ['dairy'], dietary: ['vegetarian'] },
  'Vanilla Ice Cream': { allergens: ['dairy', 'eggs'], dietary: ['vegetarian'] },
  'Fresh Mint Tea': { allergens: [], dietary: ['vegetarian', 'vegan'] },
  'Turkish Coffee': { allergens: [], dietary: ['vegan'] },
  'Fresh Orange Juice': { allergens: [], dietary: ['vegetarian', 'vegan'] },
}

/** The starter that was lost with the R27 reseed (visible in the reference). */
const GARLIC_BREAD = {
  name: 'Garlic Bread',
  nameAr: 'خبز بالثوم',
  price: 45,
  cost: 12,
  sku: 'ST-005',
  categoryName: 'Starters',
}

/** Modifier groups + modifiers (R8 fixtures, from the r23c snapshot). */
const MODIFIER_GROUPS: {
  name: string
  nameAr: string
  minSelect: number
  maxSelect: number
  sortOrder: number
  modifiers: { name: string; nameAr: string; priceDelta: number }[]
}[] = [
  {
    name: 'Coffee Size',
    nameAr: 'حجم القهوة',
    minSelect: 1,
    maxSelect: 1,
    sortOrder: 1,
    modifiers: [
      { name: 'Single', nameAr: 'مفرد', priceDelta: 0 },
      { name: 'Double', nameAr: 'دوبل', priceDelta: 15 },
      { name: 'Extra Sugar', nameAr: 'سكر إضافي', priceDelta: 0 },
    ],
  },
  {
    name: 'Juice Size',
    nameAr: 'حجم العصير',
    minSelect: 1,
    maxSelect: 1,
    sortOrder: 2,
    modifiers: [
      { name: 'Small', nameAr: 'صغير', priceDelta: 0 },
      { name: 'Medium', nameAr: 'وسط', priceDelta: 15 },
      { name: 'Large', nameAr: 'كبير', priceDelta: 25 },
    ],
  },
  {
    name: 'Spice Level',
    nameAr: 'درجة الحرارة',
    minSelect: 1,
    maxSelect: 1,
    sortOrder: 3,
    modifiers: [
      { name: 'Mild', nameAr: 'خفيف', priceDelta: 0 },
      { name: 'Medium', nameAr: 'وسط', priceDelta: 0 },
      { name: 'Hot', nameAr: 'حار', priceDelta: 0 },
      { name: 'Extra Hot', nameAr: 'حار جداً', priceDelta: 0 },
    ],
  },
  {
    name: 'Add-ons',
    nameAr: 'إضافات',
    minSelect: 0,
    maxSelect: 3,
    sortOrder: 4,
    modifiers: [
      { name: 'Extra sauce', nameAr: 'صوص إضافي', priceDelta: 8 },
      { name: 'Extra rice', nameAr: 'أرز إضافي', priceDelta: 12 },
      { name: 'Extra bread', nameAr: 'خبز إضافي', priceDelta: 10 },
      { name: 'Side salad', nameAr: 'سلطة جانبية', priceDelta: 18 },
    ],
  },
  {
    name: 'Pizza Extras',
    nameAr: 'إضافات البيتزا',
    minSelect: 0,
    maxSelect: 4,
    sortOrder: 5,
    modifiers: [
      { name: 'Extra cheese', nameAr: 'جبنة إضافية', priceDelta: 20 },
      { name: 'Mushrooms', nameAr: 'مشروم', priceDelta: 15 },
      { name: 'Olives', nameAr: 'زيتون', priceDelta: 10 },
      { name: 'Hot peppers', nameAr: 'فلفل حار', priceDelta: 10 },
    ],
  },
  {
    name: 'Dessert Toppings',
    nameAr: 'إضافات الحلويات',
    minSelect: 0,
    maxSelect: 2,
    sortOrder: 6,
    modifiers: [
      { name: 'Chocolate sauce', nameAr: 'صلصة شوكولاتة', priceDelta: 12 },
      { name: 'Crushed nuts', nameAr: 'مكسرات', priceDelta: 10 },
      { name: 'Caramel', nameAr: 'كراميل', priceDelta: 10 },
    ],
  },
  {
    name: 'Salad Dressing',
    nameAr: 'صلصة السلطة',
    minSelect: 0,
    maxSelect: 1,
    sortOrder: 7,
    modifiers: [
      { name: 'Caesar', nameAr: 'سيزر', priceDelta: 0 },
      { name: 'Ranch', nameAr: 'رانش', priceDelta: 0 },
      { name: 'Olive oil', nameAr: 'زيت زيتون', priceDelta: 0 },
    ],
  },
]

/** Product → modifier-group links (from the r23c snapshot). */
const PRODUCT_GROUP_LINKS: [string, string][] = [
  ['Turkish Coffee', 'Coffee Size'],
  ['Fresh Orange Juice', 'Juice Size'],
  ['Koshari (Classic)', 'Spice Level'],
  ['Beef Tagine', 'Spice Level'],
  ['Koshari (Classic)', 'Add-ons'],
  ['Grilled Chicken Quarter', 'Add-ons'],
  ['Beef Tagine', 'Add-ons'],
  ['Pasta Alfredo with Chicken', 'Add-ons'],
  ['Margherita Pizza', 'Pizza Extras'],
  ['Basbousa', 'Dessert Toppings'],
  ['Chocolate Lava Cake', 'Dessert Toppings'],
  ['Rice Pudding (Mahalabia)', 'Dessert Toppings'],
  ['Vanilla Ice Cream', 'Dessert Toppings'],
  ['Caesar Salad', 'Salad Dressing'],
]

/**
 * Apply the full menu enrichment to a database. Idempotent — every step
 * upserts or skips, so it can run on a fresh seed, a partially-enriched
 * DB, or repeatedly. Returns a small report for logging.
 */
export async function enrichMenu(db: PrismaClient) {
  const report = { garlicBread: '', tagged: 0, groups: 0, links: 0 }

  // 1. Garlic Bread — upsert by unique-ish name (starters category by name).
  const starters = await db.category.findFirst({ where: { name: GARLIC_BREAD.categoryName } })
  if (starters) {
    const existing = await db.product.findFirst({ where: { name: GARLIC_BREAD.name } })
    if (!existing) {
      await db.product.create({
        data: {
          name: GARLIC_BREAD.name,
          nameAr: GARLIC_BREAD.nameAr,
          categoryId: starters.id,
          price: GARLIC_BREAD.price,
          cost: GARLIC_BREAD.cost,
          sku: GARLIC_BREAD.sku,
          isSellable: true,
          isStockable: false,
          allergens: JSON.stringify(ALLERGEN_DIETARY[GARLIC_BREAD.name].allergens),
          dietary: JSON.stringify(ALLERGEN_DIETARY[GARLIC_BREAD.name].dietary),
        },
      })
      report.garlicBread = 'created'
    } else {
      report.garlicBread = 'present'
    }
  } else {
    report.garlicBread = 'skipped (no Starters category)'
  }

  // 2. Allergen/dietary tags — set where the product exists.
  for (const [name, tags] of Object.entries(ALLERGEN_DIETARY)) {
    const product = await db.product.findFirst({ where: { name } })
    if (!product) continue
    await db.product.update({
      where: { id: product.id },
      data: {
        allergens: JSON.stringify(tags.allergens),
        dietary: JSON.stringify(tags.dietary),
      },
    })
    report.tagged += 1
  }

  // 3. Modifier groups + modifiers — upsert by group name.
  const groupIds = new Map<string, number>()
  for (const g of MODIFIER_GROUPS) {
    const existing = await db.modifierGroup.findFirst({ where: { name: g.name }, include: { modifiers: true } })
    let groupId: number
    if (existing) {
      groupId = existing.id
      // backfill any missing modifiers (matched by name)
      for (const m of g.modifiers) {
        if (!existing.modifiers.some((x) => x.name === m.name)) {
          await db.modifier.create({
            data: { groupId, name: m.name, nameAr: m.nameAr, priceDelta: m.priceDelta },
          })
        }
      }
    } else {
      const created = await db.modifierGroup.create({
        data: {
          name: g.name,
          nameAr: g.nameAr,
          minSelect: g.minSelect,
          maxSelect: g.maxSelect,
          sortOrder: g.sortOrder,
          modifiers: { create: g.modifiers.map((m) => ({ name: m.name, nameAr: m.nameAr, priceDelta: m.priceDelta })) },
        },
      })
      groupId = created.id
      report.groups += 1
    }
    groupIds.set(g.name, groupId)
  }

  // 4. Product ↔ group links — create when missing.
  for (const [productName, groupName] of PRODUCT_GROUP_LINKS) {
    const product = await db.product.findFirst({ where: { name: productName } })
    const groupId = groupIds.get(groupName)
    if (!product || !groupId) continue
    const link = await db.productModifierGroup.findUnique({
      where: { productId_modifierGroupId: { productId: product.id, modifierGroupId: groupId } },
    })
    if (!link) {
      await db.productModifierGroup.create({
        data: { productId: product.id, modifierGroupId: groupId, sortOrder: MODIFIER_GROUPS.find((g) => g.name === groupName)?.sortOrder ?? 0 },
      })
      report.links += 1
    }
  }

  return report
}

// ── standalone runner: bun prisma/menu-enrichment.ts ─────────────────
const isDirect = process.argv[1]?.includes('menu-enrichment')
if (isDirect) {
  const db = new PrismaClient()
  enrichMenu(db)
    .then((report) => {
      console.log('✓ menu enrichment:', JSON.stringify(report))
    })
    .catch((e) => {
      console.error(e)
      process.exit(1)
    })
    .finally(() => db.$disconnect())
}
