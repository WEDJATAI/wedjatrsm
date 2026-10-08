// Round 8 migration — data-only changes (additive, idempotent):
//  1. Seed modifier groups + options and attach them to products
//  2. Seed allergen + dietary tags on sellable products
// Run: bun scripts/round8-migrate.ts

import { db } from '../src/lib/db'

type ModifierSeed = { name: string; nameAr?: string; priceDelta: number }

type GroupSeed = {
  name: string
  nameAr?: string
  minSelect: number
  maxSelect: number
  sortOrder: number
  modifiers: ModifierSeed[]
  /** product names the group attaches to */
  products: string[]
}

const GROUPS: GroupSeed[] = [
  {
    name: 'Coffee Size',
    nameAr: 'حجم القهوة',
    minSelect: 1,
    maxSelect: 1,
    sortOrder: 1,
    modifiers: [
      { name: 'Single', nameAr: 'مفرد', priceDelta: 0 },
      { name: 'Double', nameAr: 'دوبل', priceDelta: 15 },
    ],
    products: ['Turkish Coffee'],
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
    products: ['Fresh Orange Juice'],
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
    products: ['Koshari (Classic)', 'Beef Tagine'],
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
    products: ['Koshari (Classic)', 'Grilled Chicken Quarter', 'Beef Tagine', 'Pasta Alfredo with Chicken'],
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
    products: ['Margherita Pizza'],
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
    products: ['Vanilla Ice Cream', 'Chocolate Lava Cake', 'Basbousa', 'Rice Pudding (Mahalabia)'],
  },
  {
    name: 'Salad Dressing',
    nameAr: 'صلصة السلطة',
    minSelect: 0,
    maxSelect: 1,
    sortOrder: 7,
    modifiers: [
      { name: 'Caesar', nameAr: 'سيزر', priceDelta: 0 },
      { name: 'Ranch', nameAr: 'رانش', priceDelta: 8 },
      { name: 'Balsamic', nameAr: 'بلسميك', priceDelta: 8 },
    ],
    products: ['Caesar Salad'],
  },
]

// product name → { allergens, dietary } (JSON string arrays)
const TAGS: Record<string, { allergens?: string[]; dietary?: string[] }> = {
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

async function main() {
  let groupsCreated = 0
  let optionsCreated = 0
  let attachments = 0
  let productsTagged = 0

  for (const g of GROUPS) {
    const existing = await db.modifierGroup.findFirst({ where: { name: g.name } })
    if (existing) {
      console.log(`group "${g.name}" already exists — skipping`)
      continue
    }
    const group = await db.modifierGroup.create({
      data: {
        name: g.name,
        nameAr: g.nameAr,
        minSelect: g.minSelect,
        maxSelect: g.maxSelect,
        sortOrder: g.sortOrder,
        active: true,
      },
    })
    groupsCreated++

    let i = 0
    for (const m of g.modifiers) {
      await db.modifier.create({
        data: {
          groupId: group.id,
          name: m.name,
          nameAr: m.nameAr,
          priceDelta: m.priceDelta,
          sortOrder: ++i,
          active: true,
        },
      })
      optionsCreated++
    }

    for (const productName of g.products) {
      const product = await db.product.findFirst({ where: { name: productName } })
      if (!product) {
        console.log(`  !! product "${productName}" not found`)
        continue
      }
      await db.productModifierGroup.upsert({
        where: { productId_modifierGroupId: { productId: product.id, modifierGroupId: group.id } },
        update: {},
        create: { productId: product.id, modifierGroupId: group.id, sortOrder: group.sortOrder },
      })
      attachments++
    }
  }

  for (const [productName, tags] of Object.entries(TAGS)) {
    const product = await db.product.findFirst({ where: { name: productName } })
    if (!product) {
      console.log(`!! product "${productName}" not found for tags`)
      continue
    }
    await db.product.update({
      where: { id: product.id },
      data: {
        allergens: JSON.stringify(tags.allergens ?? []),
        dietary: JSON.stringify(tags.dietary ?? []),
      },
    })
    productsTagged++
  }

  const groups = await db.modifierGroup.count()
  const modifiers = await db.modifier.count()
  const links = await db.productModifierGroup.count()
  const tagged = await db.product.count({ where: { allergens: { not: null } } })
  console.log(
    `DONE — created ${groupsCreated} groups / ${optionsCreated} options / ${attachments} attachments; tagged ${productsTagged} products`,
  )
  console.log(`DB totals — ${groups} groups, ${modifiers} options, ${links} attachments, ${tagged} tagged products`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
