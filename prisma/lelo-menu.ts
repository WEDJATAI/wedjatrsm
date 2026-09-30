/**
 * p9 — LELO HOUSE MENU (the operator's real menu, supplied 2026-09-30).
 *
 * 23 categories · 176 items · prices in EGP exactly as printed on the house
 * menu ("All prices in EGP · Subject to service charge & VAT" — the platform
 * already applies 14% VAT + 12% service on the subtotal at order time).
 * Category Arabic names come straight from the menu headers. 🌶️ dishes are
 * stored as the platform's dietary tag "spicy" (green badge in POS + KDS).
 * Dish descriptions are preserved verbatim (new additive Product.description
 * column) including the menu's per-section service notes.
 *
 * ADDITIVE-ONLY import:
 *   - Categories are created if missing (name match); the existing demo
 *     "Desserts" category is REUSED (avoids two same-named POS tabs).
 *   - Items are keyed by a stable SKU (LO-<CAT>-<nn>) — re-runs UPDATE
 *     price/description/dietary for Lelo-managed items only; demo/seed
 *     items (no LO- SKU, different names) are never touched, never deleted.
 *   - Idempotent: safe to re-run on any DB. Standalone:
 *       bun prisma/lelo-menu.ts
 *   - Wired into prisma/seed.ts after menu-enrichment, so a future reseed
 *     can never lose the Lelo menu either.
 */
import { PrismaClient } from '@prisma/client'

type LeloItem = {
  name: string
  price: number
  desc?: string
  spicy?: boolean
}

type LeloCategory = {
  key: string // SKU prefix
  name: string
  nameAr?: string // from the menu header, when printed
  displayOrder: number // 10+ so the demo categories (1-5) keep their slots
  prep: 'kitchen' | 'bar'
  reuse?: string // reuse an existing same-named category instead of creating
  items: LeloItem[]
}

const SOUP_NOTE = 'Served with toasted bread with butter and garlic.'
const ROLLPIE_NOTE = 'Served with salad and potato cubes.'
const MAINDISH_NOTE = 'Served with two side dishes.'

export const LELO_MENU: LeloCategory[] = [
  {
    key: 'BF',
    name: 'Breakfast',
    nameAr: 'الفطور',
    displayOrder: 10,
    prep: 'kitchen',
    items: [
      {
        name: 'Oriental Breakfast',
        price: 195,
        desc: 'Beans of your choice, falafel with sesame, French fries, Alexandrian eggplant, rocca, tomatoes and onions. Served with bread, and juice or tea.',
      },
    ],
  },
  {
    key: 'CSW',
    name: 'Cold Sandwiches',
    displayOrder: 11,
    prep: 'kitchen',
    items: [
      {
        name: 'Chicken Submarine',
        price: 195,
        desc: 'Sliced chicken with tomatoes, smoked turkey and onion. Served with salad and potato cubes.',
      },
      {
        name: 'Cold Cut Toast',
        price: 210,
        desc: 'Sliced smoked beef and smoked turkey with lettuce, tomato, cheese and arugula. Served with salad and potato cubes.',
      },
      {
        name: 'Club Sandwich',
        price: 210,
        desc: 'Chicken with mayonnaise, eggs, cheese, smoked beef slices, lettuce and tomatoes. Served with salad and potato cubes.',
      },
    ],
  },
  {
    key: 'OM',
    name: 'Omelet',
    displayOrder: 12,
    prep: 'kitchen',
    items: [
      {
        name: 'Cheesy Omelet',
        price: 150,
        desc: '3 eggs with cheddar cheese. Served with bread, potato cubes and salad.',
      },
      {
        name: 'Pastrami Omelet',
        price: 180,
        desc: '3 eggs with pastrami. Served with bread, potato cubes and salad.',
      },
      {
        name: 'Mix Beef Omelet',
        price: 195,
        desc: '3 eggs with smoked beef, pepperoni and mozzarella. Served with salad and potato cubes.',
      },
      {
        name: 'Eyes Eggs',
        price: 150,
        desc: '3 eggs cooked eyes style. Served with bread, potato cubes and salad.',
      },
    ],
  },
  {
    key: 'RP',
    name: 'Roll Pie Breakfast',
    nameAr: 'فطار رول باي',
    displayOrder: 13,
    prep: 'kitchen',
    items: [
      {
        name: 'Mix Beef Roll Pie',
        price: 230,
        desc: `Smoked beef, hotdog, mixed cheese, peppers and mushrooms with scrambled eggs. ${ROLLPIE_NOTE}`,
      },
      {
        name: 'Kiri Pastrami Pie',
        price: 250,
        desc: `Kiri and pastrami, pepper and olive slices, scrambled eggs and mixed cheese. ${ROLLPIE_NOTE}`,
      },
      {
        name: 'Sausage Roll Pie',
        price: 210,
        desc: `Slices of sausage, peppers, tomatoes and olives with scrambled eggs and mixed cheese. ${ROLLPIE_NOTE}`,
      },
      {
        name: 'Mix Cheese Roll Pie',
        price: 230,
        desc: `Scrambled eggs and mixed cheese. ${ROLLPIE_NOTE}`,
      },
    ],
  },
  {
    key: 'AP',
    name: 'Appetizers',
    nameAr: 'المقبلات',
    displayOrder: 14,
    prep: 'kitchen',
    items: [
      {
        name: 'Chicken Strips',
        price: 150,
        desc: 'Cajun marinated chicken fingers, fried crispy. Served with cocktail dressing.',
      },
      {
        name: 'Half-Moon',
        price: 165,
        desc: 'Fried toast bread stuffed with chicken pieces, pepper, Cajun and cream cheese. Served with cheesy sauce.',
      },
      {
        name: 'Mozzarella Sticks',
        price: 155,
        desc: 'Fried mozzarella sticks. Served with cocktail dressing.',
      },
      {
        name: 'Combo Lelo',
        price: 210,
        desc: '5 pieces of fried mushrooms, crispy chicken, onion rings and mozzarella sticks, served with different sauces.',
      },
    ],
  },
  {
    key: 'FR',
    name: 'Fries',
    displayOrder: 15,
    prep: 'kitchen',
    items: [
      { name: 'Fries Bolognese', price: 150, desc: 'Fries with Bolognese sauce and cheesy sauce.' },
      { name: 'Fries Jalapeno Pastrami', price: 180, desc: 'Fries with jalapeno, pastrami and cheesy sauce.' },
      { name: 'Fries Chicken Crispy', price: 165, desc: 'Fries with crispy chicken and cheesy sauce.' },
      { name: 'Fries Sausage', price: 165, desc: 'Fries with Alexandrian sausage and cheesy sauce.' },
      { name: 'Fries Pepperoni Mozzarella', price: 210, desc: 'Fries with cheese sauce, mozzarella and pepperoni.' },
      { name: 'Cheese Fries (Large)', price: 105 },
    ],
  },
  {
    key: 'SP',
    name: 'Soups',
    nameAr: 'الشوربة',
    displayOrder: 16,
    prep: 'kitchen',
    items: [
      {
        name: 'Mushroom with Bacon Soup',
        price: 70,
        desc: `Mixed mushroom soup with cooked beef bacon pieces and fresh cream. ${SOUP_NOTE}`,
      },
      { name: 'Vegetable Soup', price: 65, desc: `Fresh vegetable pieces. ${SOUP_NOTE}` },
      { name: 'Orzo Soup', price: 65, desc: `Your choice of chicken or vegetables. ${SOUP_NOTE}` },
      { name: 'Seafood Soup', price: 150, desc: `Mixed seafood soup with dill and cream. ${SOUP_NOTE}` },
      { name: 'Creamy Chicken Soup', price: 80, desc: `Chicken pieces in fresh creamy soup. ${SOUP_NOTE}` },
    ],
  },
  {
    key: 'SA',
    name: 'Salads',
    nameAr: 'السلطات',
    displayOrder: 17,
    prep: 'kitchen',
    items: [
      {
        name: 'Lelo Salad',
        price: 180,
        desc: 'Fresh rocca, lettuce, Doritos, croutons, red cheese and olive slices, seasoned with Lelo sauce and dill. Choose grilled or crispy chicken.',
      },
      {
        name: 'Chicken Caesar Salad',
        price: 190,
        desc: 'Chicken, lettuce, croutons, Parmesan cheese and Caesar dressing.',
      },
      {
        name: 'Greek Salad',
        price: 150,
        desc: 'Lettuce, olives, tomatoes, cucumber, onions, feta cheese, oregano and Greek sauce.',
      },
      {
        name: 'Chicken Ranch Salad',
        price: 180,
        desc: 'Grilled chicken pieces with lettuce, tomatoes, onions, arugula, tortilla bread, cucumbers and grated cheese, seasoned with ranch sauce.',
      },
      {
        name: 'Sweet and Sour Chicken Salad',
        price: 180,
        desc: 'Roasted peppers and carrot lettuce with tomatoes, Doritos, red cheddar and sweet and sour sauce.',
      },
      {
        name: 'Tuna Salad',
        price: 230,
        desc: 'Sweet peppers with onions, arugula, lemon juice and mayonnaise.',
      },
      { name: 'Oriental Salad', price: 65, desc: 'All fresh vegetables.' },
    ],
  },
  {
    key: 'PL',
    name: 'Pan Lelo',
    nameAr: 'بان ليلو',
    displayOrder: 18,
    prep: 'kitchen',
    items: [
      {
        name: 'Beef Alexandrian Liver Pan',
        price: 180,
        desc: 'Beef liver with pepper and the special seasoning.',
      },
      {
        name: 'Beef Alexandrian Sausage Pan',
        price: 175,
        desc: 'Beef sausage with tomato and hot pepper.',
        spicy: true,
      },
      { name: 'Kebab Hala Pan', price: 220, desc: 'Kebab cooked with onions and mixed cheese.' },
      { name: 'Beef Liver Dips Pan', price: 190, desc: 'Grilled beef liver slices with dips and rocca.' },
      { name: 'Sausage Melt Pan', price: 200, desc: 'Grilled sausage pieces with cheese sauce and melted cheese.' },
      { name: 'Chicken Crispy Melt Pan', price: 220, desc: 'Crispy chicken pieces with cheese sauce and melted cheese.' },
    ],
  },
  {
    key: 'SW',
    name: 'Sandwiches',
    nameAr: 'الساندوتشات',
    displayOrder: 19,
    prep: 'kitchen',
    items: [
      { name: 'Cheesy Beef Burger', price: 185, desc: 'Beef.' },
      { name: 'Burger Doritos B.B.Q', price: 195, desc: 'Beef.' },
      { name: 'Lelo Beef Sandwich', price: 210, desc: 'Beef.' },
      { name: 'Alexandrian Liver', price: 150, desc: 'Beef.' },
      { name: 'Alexandrian Sausage', price: 150, desc: 'Beef.' },
      { name: 'Hawawshi Meat Cheese', price: 145, desc: 'Beef.' },
      { name: 'Chicken Crispy Sandwich', price: 180, desc: 'Chicken.' },
      { name: 'Quesadilla Chicken', price: 210, desc: 'Chicken.' },
      { name: 'Chicken Lelo', price: 195, desc: 'Chicken.' },
      { name: 'Chicken Roll Up', price: 195, desc: 'Chicken.' },
      { name: 'Shrimp Ranchy', price: 290, desc: 'Seafood.' },
    ],
  },
  {
    key: 'PA',
    name: 'Pasta',
    nameAr: 'المكرونة',
    displayOrder: 20,
    prep: 'kitchen',
    items: [
      { name: 'Arabita', price: 110, desc: 'Sliced chili with olives, garlic and red sauce.', spicy: true },
      {
        name: 'Crispy Doritos Ranch',
        price: 195,
        desc: 'Crispy chicken, jalapeno, tomato pieces, ranch sauce and Doritos pieces.',
      },
      {
        name: 'Mexican Chicken',
        price: 210,
        desc: 'Slices of chicken, chili, olives, pepper, hot Mexican sauce and cheese sauce.',
        spicy: true,
      },
      { name: 'Crispy Chicken', price: 230, desc: 'Crispy chicken pieces with cheese sauce and melted cheese.' },
      {
        name: 'Chicken Negresco',
        price: 230,
        desc: 'Marinated chicken pieces and mushrooms with Negresco sauce and melted cheese.',
      },
      { name: 'Seafood Negresco', price: 345, desc: 'Mixed seafood with crab, Negresco sauce and melted cheese.' },
      {
        name: 'Kebab Pasta',
        price: 260,
        desc: 'Cooked kebab with onions and brown sauce, topped with mixed cheese and melted cheese.',
      },
      { name: 'Lelo Beef', price: 250, desc: 'Beef mince with mushrooms, peppers and creamy gravy sauce.' },
      { name: 'Alfredo Chicken', price: 185, desc: 'Alfredo sauce with Parmesan cheese, mushrooms and chicken pieces.' },
      { name: 'Fruit De Marie', price: 340, desc: 'Mixed seafood and minced garlic with fresh creamy sauce and dill.' },
      { name: 'Alexandrian Liver Pasta', price: 185 },
      { name: 'Alexandrian Sausage Pasta', price: 185 },
      { name: 'Oven Cheese Sausage', price: 230 },
    ],
  },
  {
    key: 'VE',
    name: 'Vermicelli',
    nameAr: 'الشعرية',
    displayOrder: 21,
    prep: 'kitchen',
    items: [
      { name: 'Alexandrian Liver Vermicelli', price: 230 },
      { name: 'Alexandrian Sausage Vermicelli', price: 230 },
      { name: 'Vermicelli Kebab Halla', price: 250 },
    ],
  },
  {
    key: 'MD',
    name: 'Main Dishes',
    nameAr: 'الأطباق الرئيسية',
    displayOrder: 22,
    prep: 'kitchen',
    items: [
      { name: 'Beef Tenderloin', price: 450, desc: `Beef. ${MAINDISH_NOTE}` },
      { name: 'Beef Stroganoff', price: 425, desc: `Beef. ${MAINDISH_NOTE}` },
      { name: 'Beef Fajita', price: 420, desc: `Beef. ${MAINDISH_NOTE}` },
      { name: 'Mix Grill', price: 450, desc: `Beef. ${MAINDISH_NOTE}` },
      { name: 'Piccata Mushroom Sauce', price: 420, desc: `Beef. ${MAINDISH_NOTE}` },
      { name: 'Veal Scallop', price: 450, desc: `Beef. ${MAINDISH_NOTE}` },
      { name: 'Grilled Chicken', price: 280, desc: `Chicken. ${MAINDISH_NOTE}` },
      { name: 'Cordon Bleu', price: 299, desc: `Chicken. ${MAINDISH_NOTE}` },
      { name: 'Country Chicken', price: 299, desc: `Chicken. ${MAINDISH_NOTE}` },
      { name: 'Chicken Fajita', price: 320, desc: `Chicken. ${MAINDISH_NOTE}` },
      { name: 'Shish Tawook', price: 285, desc: `Chicken. ${MAINDISH_NOTE}` },
      { name: 'Fish with Shrimp & Crab', price: 450, desc: `Seafood. ${MAINDISH_NOTE}` },
      { name: 'Mix Seafood Casserole', price: 470, desc: `Seafood. ${MAINDISH_NOTE}` },
    ],
  },
  {
    key: 'PZ',
    name: 'Pizza',
    nameAr: 'البيتزا',
    displayOrder: 23,
    prep: 'kitchen',
    items: [
      { name: 'Margarita', price: 155 },
      { name: 'Vegetables', price: 165 },
      { name: 'Supreme', price: 195 },
      { name: 'Quattro Formaggio', price: 230 },
      { name: 'Seafood Ranch', price: 350 },
      { name: 'BBQ Chicken', price: 195 },
      { name: 'Crispy Chicken Ranch', price: 195 },
      { name: 'Pepperoni Pizza', price: 195 },
    ],
  },
  {
    key: 'DE',
    name: 'Desserts',
    nameAr: 'الحلويات',
    displayOrder: 3, // reuse demo category (kept at its slot) — no new tab
    prep: 'kitchen',
    reuse: 'Desserts',
    items: [
      { name: 'Brownies', price: 120 },
      { name: 'Creamy Kunafa', price: 120 },
      { name: 'Cheese Cake', price: 120 },
      { name: 'Molten Ice Cream', price: 120 },
      { name: 'Fettuccine Crepe', price: 110 },
      { name: 'Oreo Madness', price: 135 },
      { name: 'Cheese Madness', price: 135 },
      { name: 'Ice Cream', price: 45 },
      { name: 'Um Ali', price: 85 },
      { name: 'Fruit Salad', price: 85 },
    ],
  },
  {
    key: 'FJ',
    name: 'Fresh Juices',
    nameAr: 'العصائر الطازجة',
    displayOrder: 24,
    prep: 'bar',
    items: [
      { name: 'Mango Juice', price: 85 },
      { name: 'Strawberry Juice', price: 80 },
      { name: 'Guava Juice', price: 80 },
      { name: 'Orange Juice', price: 85 },
      { name: 'Kiwi Juice', price: 80 },
      { name: 'Kiwi Mango Juice', price: 95 },
      { name: 'Lemon Juice', price: 65 },
      { name: 'Lemon Mint Juice', price: 70 },
      { name: 'Banana Juice with Milk', price: 85 },
      { name: 'Watermelon Juice', price: 80 },
    ],
  },
  {
    key: 'MS',
    name: 'Milkshake',
    nameAr: 'ميلك شيك',
    displayOrder: 25,
    prep: 'bar',
    items: [
      { name: 'Vanilla Milkshake', price: 99 },
      { name: 'Chocolate Milkshake', price: 99 },
      { name: 'Mango Milkshake', price: 99 },
      { name: 'Strawberry Milkshake', price: 99 },
      { name: 'Caramel Milkshake', price: 99 },
      { name: 'Blueberry Milkshake', price: 99 },
      { name: 'Oreo Milkshake', price: 99 },
      { name: 'Lotus Milkshake', price: 99 },
    ],
  },
  {
    key: 'HD',
    name: 'Hot Drinks',
    nameAr: 'المشروبات الساخنة',
    displayOrder: 26,
    prep: 'bar',
    items: [
      { name: 'Anti-Flu', price: 75 },
      { name: 'Hot Cider', price: 85 },
      { name: 'Lemon with Honey', price: 65 },
      { name: 'Turkish Coffee (Single)', price: 45 },
      { name: 'Turkish Coffee (Double)', price: 55 },
      { name: 'French Coffee', price: 65 },
      { name: 'Hazelnut Coffee', price: 85 },
      { name: 'Herbs', price: 60 },
      { name: 'Red Tea', price: 40 },
      { name: 'Green Tea', price: 40 },
      { name: 'Sahlab with Nuts', price: 85 },
      { name: 'Sahlab Lotus', price: 95 },
      { name: 'Espresso (Single)', price: 45 },
      { name: 'Espresso (Double)', price: 55 },
      { name: 'Mikato (Single)', price: 50 },
      { name: 'Mikato (Double)', price: 60 },
      { name: 'American Coffee', price: 60 },
      { name: 'Flat White', price: 85 },
      { name: 'Cappuccino', price: 85 },
      { name: 'Latte Cafe', price: 80 },
      { name: 'Mocha', price: 90 },
      { name: 'Classic Hot Chocolate', price: 85 },
      { name: 'Nutella Hot Chocolate', price: 95 },
      { name: 'Nescafe', price: 75 },
    ],
  },
  {
    key: 'IC',
    name: 'Iced Coffee & Chocolate',
    nameAr: 'القهوة والشوكولاتة المثلجة',
    displayOrder: 27,
    prep: 'bar',
    items: [
      { name: 'Iced Coffee', price: 80 },
      { name: 'Iced Latte', price: 85 },
      { name: 'Iced Cappuccino', price: 90 },
      { name: 'Light Frappuccino', price: 90 },
      { name: 'Strong Frappuccino', price: 95 },
      { name: 'Iced Mocha', price: 95 },
      { name: 'Iced Chocolate', price: 95 },
    ],
  },
  {
    key: 'FS',
    name: 'Frappe & Smoothie',
    nameAr: 'فرابيه وسموثي',
    displayOrder: 28,
    prep: 'bar',
    items: [
      { name: 'Oreo Frappe', price: 95 },
      { name: 'Mocha Frappe', price: 90 },
      { name: 'Kit Kat Frappe', price: 110 },
      { name: 'Twist Marshmallow', price: 110 },
      { name: 'Maltesers', price: 110 },
      { name: 'Smoothie', price: 95 },
      { name: 'Mango Passion Fruit', price: 95 },
    ],
  },
  {
    key: 'CK',
    name: 'Cocktails',
    nameAr: 'الكوكتيلات',
    displayOrder: 29,
    prep: 'bar',
    items: [
      { name: 'Mojito', price: 95 },
      { name: 'Green Apple Mojito', price: 95 },
      { name: 'New Florida', price: 95 },
      { name: 'Lelo Cocktail', price: 99 },
      { name: 'Blue Beach', price: 99 },
      { name: 'Tropical', price: 99 },
      { name: 'Blue Lelo', price: 99 },
    ],
  },
  {
    key: 'SD',
    name: 'Soft Drinks & Water',
    nameAr: 'المشروبات الغازية والمياه',
    displayOrder: 30,
    prep: 'bar',
    items: [
      { name: 'Cola', price: 43 },
      { name: 'Cola Zero', price: 43 },
      { name: 'Sprite', price: 43 },
      { name: 'Sprite Diet', price: 43 },
      { name: 'Red Bull', price: 95 },
      { name: 'Birell', price: 55 },
      { name: 'Moussy', price: 55 },
      { name: 'Small Water', price: 20 },
      { name: 'Large Water', price: 30 },
    ],
  },
  {
    key: 'YG',
    name: 'Yogurt',
    nameAr: 'الزبادي',
    displayOrder: 31,
    prep: 'bar',
    items: [
      { name: 'Yogurt Honey', price: 85 },
      { name: 'Yogurt Mango', price: 95 },
      { name: 'Yogurt Strawberry', price: 95 },
      { name: 'Yogurt Blueberry', price: 95 },
      { name: 'Yogurt Peach', price: 95 },
      { name: 'Yogurt Fruits', price: 110 },
    ],
  },
]

/** Total items across the menu (sanity guard for the importer). */
export const LELO_ITEM_COUNT = LELO_MENU.reduce((n, c) => n + c.items.length, 0)

/**
 * Idempotent additive import. Returns counts for honest reporting.
 * Never deletes; only creates missing rows and updates LO-* SKU items.
 */
export async function importLeloMenu(db: PrismaClient) {
  let categoriesCreated = 0
  let categoriesReused = 0
  let itemsCreated = 0
  let itemsUpdated = 0

  for (const cat of LELO_MENU) {
    // Resolve the category: reuse an existing same-named row if the menu
    // maps onto it (demo "Desserts"); otherwise create-if-missing by name.
    let row = await db.category.findFirst({
      where: { name: cat.reuse ?? cat.name },
      orderBy: { id: 'asc' },
    })
    if (!row) {
      row = await db.category.create({
        data: {
          name: cat.name,
          nameAr: cat.nameAr,
          displayOrder: cat.displayOrder,
          prepDestination: cat.prep,
        },
      })
      categoriesCreated++
    } else {
      categoriesReused++
    }

    for (const [i, item] of cat.items.entries()) {
      const sku = `LO-${cat.key}-${String(i + 1).padStart(2, '0')}`
      const data = {
        name: item.name,
        categoryId: row.id,
        price: item.price,
        isSellable: true,
        active: true,
        dietary: item.spicy ? '["spicy"]' : null,
        description: item.desc ?? null,
      }
      const existing = await db.product.findFirst({ where: { sku } })
      if (existing) {
        // Lelo-managed item: refresh price/description/tags (menu reprint)
        await db.product.update({ where: { id: existing.id }, data })
        itemsUpdated++
      } else {
        await db.product.create({ data: { ...data, sku } })
        itemsCreated++
      }
    }
  }

  return { categoriesCreated, categoriesReused, itemsCreated, itemsUpdated }
}

// ── Standalone runner: `bun prisma/lelo-menu.ts` ─────────────────────
const isDirectRun =
  typeof process !== 'undefined' &&
  (process.argv[1] ?? '').replace(/\\/g, '/').endsWith('lelo-menu.ts')

if (isDirectRun) {
  const db = new PrismaClient()
  importLeloMenu(db)
    .then((r) => {
      const total = LELO_ITEM_COUNT
      console.log(
        `✓ Lelo menu: ${r.itemsCreated} items created, ${r.itemsUpdated} refreshed ` +
          `(expected ${total}) · categories ${r.categoriesCreated} created / ${r.categoriesReused} reused`,
      )
      if (r.itemsCreated + r.itemsUpdated !== total) {
        console.error(`✗ COUNT MISMATCH: menu defines ${total} items`)
        process.exitCode = 1
      }
    })
    .catch((e) => {
      console.error(e)
      process.exitCode = 1
    })
    .finally(() => db.$disconnect())
}
