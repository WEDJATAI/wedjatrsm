/* Seed script: run with `bun prisma/seed.ts` */
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'

const db = new PrismaClient()

async function main() {
  console.log('Seeding RMS database...')

  // Clear existing data (order matters due to FKs)
  await db.auditLog.deleteMany()
  await db.attendance.deleteMany()
  await db.cashDrawerEntry.deleteMany()
  await db.cashDrawerSession.deleteMany()
  await db.reservation.deleteMany()
  await db.inventoryTransaction.deleteMany()
  await db.payment.deleteMany()
  await db.orderItem.deleteMany()
  await db.order.deleteMany()
  await db.recipeComponent.deleteMany()
  await db.visionTableState.deleteMany()
  await db.visionZone.deleteMany()
  await db.visionEvent.deleteMany()
  await db.movementCandidate.deleteMany()
  await db.visionCamera.deleteMany()
  await db.customer.deleteMany()
  await db.restaurantTable.deleteMany()
  await db.floorPlan.deleteMany()
  await db.modifier.deleteMany()
  await db.modifierGroup.deleteMany()
  await db.product.deleteMany()
  await db.category.deleteMany()
  await db.appSetting.deleteMany()
  await db.user.deleteMany()

  // ── Users ─────────────────────────────────────────────────────────
  const admin = await db.user.create({
    data: {
      email: 'admin@rms.com',
      passwordHash: await bcrypt.hash('admin123', 10),
      name: 'Amina Hassan',
      role: 'admin',
      pin: '1234',
    },
  })
  const waiter = await db.user.create({
    data: {
      email: 'waiter@rms.com',
      passwordHash: await bcrypt.hash('waiter123', 10),
      name: 'Omar Khaled',
      role: 'waiter',
      pin: '1111',
    },
  })
  await db.user.create({
    data: {
      email: 'kitchen@rms.com',
      passwordHash: await bcrypt.hash('kitchen123', 10),
      name: 'Chef Layla',
      role: 'kitchen',
      pin: '2222',
    },
  })
  console.log('✓ users:', [admin.email, waiter.email, 'kitchen@rms.com'])

  // ── Categories (visible POS categories + a hidden ingredients group) ──
  const catStarter = await db.category.create({ data: { name: 'Starters', displayOrder: 1, prepDestination: 'kitchen' } })
  const catMain = await db.category.create({ data: { name: 'Main Courses', displayOrder: 2, prepDestination: 'kitchen' } })
  const catDessert = await db.category.create({ data: { name: 'Desserts', displayOrder: 3, prepDestination: 'kitchen' } })
  const catBeverage = await db.category.create({ data: { name: 'Beverages', displayOrder: 4, prepDestination: 'bar' } })
  const catShisha = await db.category.create({
    data: { name: 'Shisha', nameAr: 'شيشة', displayOrder: 5, prepDestination: 'shisha' },
  })
  const catIngredient = await db.category.create({
    data: { name: 'Ingredients (internal)', displayOrder: 99, active: false },
  })
  console.log('✓ categories: 6 (incl. shisha — routed to kitchen/bar/shisha stations)')

  // ── Ingredients (stockable, not sellable) ─────────────────────────
  const ing = async (name: string, cost: number, stock: number, threshold: number, sku: string) =>
    db.product.create({
      data: {
        name,
        categoryId: catIngredient.id,
        cost,
        price: 0,
        isStockable: true,
        isSellable: false,
        sku,
        stock,
        lowStockThreshold: threshold,
      },
    })

  const chicken = await ing('Chicken Breast', 85, 12, 5, 'ING-CHI')
  const beef = await ing('Beef Fillet', 260, 6, 4, 'ING-BEF')
  const rice = await ing('Rice (kg)', 28, 20, 8, 'ING-RIC')
  const tomato = await ing('Tomatoes (kg)', 12, 9, 4, 'ING-TOM')
  const onion = await ing('Onions (kg)', 10, 14, 5, 'ING-ONI')
  const potato = await ing('Potatoes (kg)', 15, 25, 10, 'ING-POT')
  const pasta = await ing('Pasta (kg)', 32, 8, 4, 'ING-PAS')
  const cream = await ing('Cooking Cream (L)', 60, 5, 3, 'ING-CRM')
  const cheese = await ing('Cheese (kg)', 180, 4, 2, 'ING-CHS')
  const egg = await ing('Eggs (dozen)', 55, 6, 3, 'ING-EGG')
  const chocolate = await ing('Chocolate (kg)', 210, 3, 2, 'ING-CHO')
  const flour = await ing('Flour (kg)', 18, 15, 6, 'ING-FLR')
  const coffee = await ing('Coffee Beans (kg)', 340, 2.5, 1, 'ING-COF')
  const milk = await ing('Milk (L)', 24, 18, 8, 'ING-MLK')
  const fish = await ing('Tilapia Fillet', 95, 7, 3, 'ING-FSH')
  const lemon = await ing('Lemons (kg)', 20, 5, 3, 'ING-LEM')
  const mint = await ing('Fresh Mint (bunch)', 8, 4, 2, 'ING-MNT')
  const tea = await ing('Tea Leaves (kg)', 120, 2, 1, 'ING-TEA')
  const oliveOil = await ing('Olive Oil (L)', 150, 6, 2, 'ING-OIL')
  console.log('✓ ingredients: 18')

  // ── Sellable products ─────────────────────────────────────────────
  const dish = (args: {
    name: string
    cat: number
    price: number
    cost: number
    sku: string
    stockable?: boolean
    stock?: number
    threshold?: number
  }) =>
    db.product.create({
      data: {
        name: args.name,
        categoryId: args.cat,
        price: args.price,
        cost: args.cost,
        sku: args.sku,
        isStockable: args.stockable ?? false,
        isSellable: true,
        stock: args.stock ?? 0,
        lowStockThreshold: args.threshold ?? 0,
      },
    })

  const hummus = await dish({ name: 'Hummus with Olive Oil', cat: catStarter.id, price: 65, cost: 18, sku: 'ST-001' })
  const falafel = await dish({ name: 'Falafel Plate (6 pcs)', cat: catStarter.id, price: 55, cost: 15, sku: 'ST-002' })
  const soup = await dish({ name: 'Cream of Tomato Soup', cat: catStarter.id, price: 60, cost: 20, sku: 'ST-003' })
  const salad = await dish({ name: 'Caesar Salad', cat: catStarter.id, price: 95, cost: 38, sku: 'ST-004' })

  const koshari = await dish({ name: 'Koshari (Classic)', cat: catMain.id, price: 85, cost: 25, sku: 'MN-001' })
  const grilledChicken = await dish({ name: 'Grilled Chicken Quarter', cat: catMain.id, price: 175, cost: 62, sku: 'MN-002' })
  const beefTagine = await dish({ name: 'Beef Tagine', cat: catMain.id, price: 240, cost: 95, sku: 'MN-003' })
  const pastaAlfredo = await dish({ name: 'Pasta Alfredo with Chicken', cat: catMain.id, price: 190, cost: 70, sku: 'MN-004' })
  const grilledTilapia = await dish({ name: 'Grilled Tilapia Fillet', cat: catMain.id, price: 210, cost: 80, sku: 'MN-005' })
  const margherita = await dish({ name: 'Margherita Pizza', cat: catMain.id, price: 160, cost: 48, sku: 'MN-006' })

  const basbousa = await dish({ name: 'Basbousa', cat: catDessert.id, price: 55, cost: 16, sku: 'DS-001' })
  const chocolateCake = await dish({ name: 'Chocolate Lava Cake', cat: catDessert.id, price: 85, cost: 30, sku: 'DS-002' })
  const ricePudding = await dish({ name: 'Rice Pudding (Mahalabia)', cat: catDessert.id, price: 50, cost: 14, sku: 'DS-003' })
  const iceCream = await dish({ name: 'Vanilla Ice Cream', cat: catDessert.id, price: 45, cost: 12, sku: 'DS-004' })

  const mintTea = await dish({ name: 'Fresh Mint Tea', cat: catBeverage.id, price: 30, cost: 6, sku: 'BV-001' })
  const turkishCoffee = await dish({ name: 'Turkish Coffee', cat: catBeverage.id, price: 40, cost: 10, sku: 'BV-002' })
  const softDrink = await dish({ name: 'Soft Drink (Can)', cat: catBeverage.id, price: 25, cost: 9, sku: 'BV-003', stockable: true, stock: 24, threshold: 12 })
  const water = await dish({ name: 'Mineral Water 600ml', cat: catBeverage.id, price: 20, cost: 6, sku: 'BV-004', stockable: true, stock: 30, threshold: 12 })
  const freshJuice = await dish({ name: 'Fresh Orange Juice', cat: catBeverage.id, price: 55, cost: 20, sku: 'BV-005' })

  // ── Shisha flavors (routed to the shisha station) ──────────────
  const shisha = (name: string, nameAr: string, price: number, cost: number, sku: string) =>
    db.product.create({
      data: { name, nameAr, categoryId: catShisha.id, price, cost, isSellable: true, sku },
    })
  await shisha('Double Apple (Maassel)', 'تفاحتين', 90, 28, 'SH-001')
  await shisha('Fresh Mint', 'نعناع', 75, 22, 'SH-002')
  await shisha('Grape & Mint', 'عنب ونعناع', 85, 25, 'SH-003')
  await shisha('Watermelon', 'بطيخ', 85, 25, 'SH-004')
  await shisha('Peach', 'خوخ', 85, 25, 'SH-005')
  await shisha('Lemon & Mint', 'ليمون بالنعناع', 80, 24, 'SH-006')
  await shisha('Mixed Fruit', 'فواكه مشكلة', 95, 30, 'SH-007')
  await shisha('Jasmine', 'ياسمين', 90, 28, 'SH-008')
  await shisha('Blueberry', 'بلوبيري', 95, 30, 'SH-009')
  await shisha('Premium Head Upgrade', 'رأس بريميوم', 45, 12, 'SH-010')
  console.log('✓ sellable products: 28 (incl. 10 shisha flavors)')

  // ── Recipes (BOM) ─────────────────────────────────────────────────
  const rc = (productId: number, ingredientId: number, quantity: number) =>
    db.recipeComponent.create({ data: { productId, ingredientId, quantity } })

  await rc(hummus.id, oliveOil.id, 0.02)
  await rc(falafel.id, oliveOil.id, 0.03)
  await rc(soup.id, tomato.id, 0.15)
  await rc(soup.id, cream.id, 0.05)
  await rc(soup.id, onion.id, 0.03)
  await rc(salad.id, chicken.id, 0.08)
  await rc(salad.id, cheese.id, 0.04)
  await rc(salad.id, oliveOil.id, 0.01)

  await rc(koshari.id, rice.id, 0.25)
  await rc(koshari.id, tomato.id, 0.12)
  await rc(koshari.id, onion.id, 0.08)
  await rc(grilledChicken.id, chicken.id, 0.3)
  await rc(grilledChicken.id, potato.id, 0.2)
  await rc(grilledChicken.id, lemon.id, 0.03)
  await rc(beefTagine.id, beef.id, 0.3)
  await rc(beefTagine.id, onion.id, 0.12)
  await rc(beefTagine.id, potato.id, 0.15)
  await rc(beefTagine.id, tomato.id, 0.1)
  await rc(pastaAlfredo.id, pasta.id, 0.18)
  await rc(pastaAlfredo.id, chicken.id, 0.15)
  await rc(pastaAlfredo.id, cream.id, 0.1)
  await rc(grilledTilapia.id, fish.id, 0.25)
  await rc(grilledTilapia.id, lemon.id, 0.04)
  await rc(margherita.id, flour.id, 0.2)
  await rc(margherita.id, cheese.id, 0.12)
  await rc(margherita.id, tomato.id, 0.1)

  await rc(basbousa.id, flour.id, 0.1)
  await rc(basbousa.id, cream.id, 0.05)
  await rc(chocolateCake.id, chocolate.id, 0.07)
  await rc(chocolateCake.id, egg.id, 0.5)
  await rc(chocolateCake.id, flour.id, 0.06)
  await rc(chocolateCake.id, milk.id, 0.08)
  await rc(ricePudding.id, rice.id, 0.1)
  await rc(ricePudding.id, milk.id, 0.25)
  await rc(mintTea.id, tea.id, 0.01)
  await rc(mintTea.id, mint.id, 0.05)
  await rc(turkishCoffee.id, coffee.id, 0.015)
  await rc(freshJuice.id, lemon.id, 0.05)
  console.log('✓ recipe components: 35')

  // ── Opening stock transactions (purchases) ────────────────────────
  const ingredients = [chicken, beef, rice, tomato, onion, potato, pasta, cream, cheese, egg, chocolate, flour, coffee, milk, fish, lemon, mint, tea, oliveOil]
  for (const i of ingredients.concat([softDrink, water])) {
    await db.inventoryTransaction.create({
      data: {
        productId: i.id,
        quantityChange: i.stock,
        reason: 'purchase',
      },
    })
  }

  // ── Floor plan + tables ───────────────────────────────────────────
  const hall = await db.floorPlan.create({ data: { name: 'Main Hall' } })
  const terrace = await db.floorPlan.create({ data: { name: 'Terrace' } })

  const tablePositions = [
    ['T1', 2, 18, 20], ['T2', 2, 45, 20], ['T3', 4, 72, 20], ['T4', 4, 18, 50],
    ['T5', 4, 45, 50], ['T6', 6, 72, 50], ['T7', 2, 18, 80], ['T8', 4, 45, 80],
    ['T9', 4, 72, 80],
  ] as const
  for (const [name, capacity, x, y] of tablePositions) {
    await db.restaurantTable.create({
      data: { floorPlanId: hall.id, name, capacity, positionX: x, positionY: y },
    })
  }
  await db.restaurantTable.create({ data: { floorPlanId: terrace.id, name: 'P1', capacity: 2, positionX: 25, positionY: 35 } })
  await db.restaurantTable.create({ data: { floorPlanId: terrace.id, name: 'P2', capacity: 4, positionX: 65, positionY: 35 } })
  await db.restaurantTable.create({ data: { floorPlanId: terrace.id, name: 'P3', capacity: 6, positionX: 45, positionY: 75 } })
  console.log('✓ floor plans: 2, tables: 12')

  // ── Historical orders for reports (paid, over the last 7 days) ────
  const dishes = [
    { p: hummus, c: 'starter' }, { p: falafel, c: 'starter' }, { p: soup, c: 'starter' }, { p: salad, c: 'starter' },
    { p: koshari, c: 'main' }, { p: grilledChicken, c: 'main' }, { p: beefTagine, c: 'main' },
    { p: pastaAlfredo, c: 'main' }, { p: grilledTilapia, c: 'main' }, { p: margherita, c: 'main' },
    { p: basbousa, c: 'dessert' }, { p: chocolateCake, c: 'dessert' }, { p: ricePudding, c: 'dessert' }, { p: iceCream, c: 'dessert' },
    { p: mintTea, c: 'drink' }, { p: turkishCoffee, c: 'drink' }, { p: softDrink, c: 'drink' }, { p: water, c: 'drink' }, { p: freshJuice, c: 'drink' },
  ]
  const methods = ['cash', 'card', 'cash', 'card', 'other']
  let rng = 42
  const rand = () => {
    rng = (rng * 1103515245 + 12345) % 2147483648
    return rng / 2147483648
  }

  const now = new Date()
  for (let d = 6; d >= 0; d--) {
    const ordersToday = 3 + Math.floor(rand() * 5) // 3-7 orders/day
    for (let o = 0; o < ordersToday; o++) {
      const created = new Date(now)
      created.setDate(created.getDate() - d)
      created.setHours(12 + Math.floor(rand() * 9), Math.floor(rand() * 60), 0, 0)
      const itemCount = 2 + Math.floor(rand() * 4)
      const items: { productId: number; quantity: number; unitPrice: number; course: string; status: string }[] = []
      for (let i = 0; i < itemCount; i++) {
        const pick = dishes[Math.floor(rand() * dishes.length)]
        items.push({
          productId: pick.p.id,
          quantity: 1 + Math.floor(rand() * 2),
          unitPrice: pick.p.price,
          course: pick.c,
          status: 'served',
        })
      }
      const subtotal = items.reduce((s, it) => s + it.unitPrice * it.quantity, 0)
      const discount = rand() < 0.2 ? Math.round(subtotal * 0.1) : 0
      const tax = (subtotal - discount) * 0.14
      const total = Math.round((subtotal - discount + tax) * 100) / 100
      const order = await db.order.create({
        data: {
          userId: waiter.id,
          status: 'paid',
          orderType: 'takeaway', // seed history is table-less
          subtotalAmount: subtotal,
          discountAmount: discount,
          taxAmount: tax,
          totalAmount: total,
          createdAt: created,
          closedAt: new Date(created.getTime() + 45 * 60000),
          items: { create: items.map((it) => ({ ...it, createdAt: created })) },
        },
      })
      await db.payment.create({
        data: {
          orderId: order.id,
          method: methods[Math.floor(rand() * methods.length)],
          amount: total,
          createdAt: new Date(created.getTime() + 45 * 60000),
        },
      })
    }
  }
  console.log('✓ historical paid orders seeded (7 days)')

  // ── R13: loyalty program settings + demo customers ────────────────
  await db.appSetting.createMany({
    data: [
      { key: 'loyaltyEnabled', value: 'true' },
      { key: 'loyaltyPointsPerEgp', value: '0.1' }, // 1 pt per EGP 10 spent
      { key: 'loyaltyEgpPerPoint', value: '1' }, // 1 pt redeems EGP 1
    ],
  })
  await db.customer.createMany({
    data: [
      { name: 'Mona Test Customer', phone: '0100 555 0199', points: 20, visits: 1, totalSpent: 226.8, lastVisitAt: new Date() },
      { name: 'Karim Regular', phone: '0122 333 4455', points: 5, visits: 2, totalSpent: 480.5, lastVisitAt: new Date(Date.now() - 3 * 86400000) },
    ],
  })
  console.log('✓ loyalty: enabled (0.1 pts/EGP · EGP 1/pt) + 2 demo customers')

  // ── R9 parity: vision subsystem (cameras + zones + table states) ──
  const cam1 = await db.visionCamera.create({
    data: { code: 'CAM-001', name: 'Main Hall Cam', floorPlanId: hall.id, status: 'online' },
  })
  const cam2 = await db.visionCamera.create({
    data: { code: 'CAM-002', name: 'Terrace Cam', floorPlanId: terrace.id, status: 'online' },
  })
  // zone polygons mirror the live demo (normalized 0..1 camera coords)
  const zone = (cameraId: number, name: string, tableId: number, x: number, y: number, seats: number) => ({
    cameraId, name, kind: 'table', tableId, seats,
    polygon: JSON.stringify([
      { x: round3(x), y: round3(y) },
      { x: round3(x + 0.12), y: round3(y) },
      { x: round3(x + 0.12), y: round3(y + 0.12) },
      { x: round3(x), y: round3(y + 0.12) },
    ]),
  })
  const round3 = (n: number) => Math.round(n * 1000) / 1000
  const hallTables = await db.restaurantTable.findMany({ where: { floorPlanId: hall.id }, orderBy: { id: 'asc' } })
  const terraceTables = await db.restaurantTable.findMany({ where: { floorPlanId: terrace.id }, orderBy: { id: 'asc' } })
  await db.visionZone.createMany({
    data: [
      zone(cam1.id, 'Z-T1', hallTables[0].id, 0.095, 0.087, 2),
      zone(cam1.id, 'Z-T2', hallTables[1].id, 0.464, 0.094, 4),
      zone(cam1.id, 'Z-T3', hallTables[2].id, 0.141, 0.753, 4),
      zone(cam2.id, 'Z-P1', terraceTables[0].id, 0.19, 0.29, 2),
      zone(cam2.id, 'Z-P2', terraceTables[1].id, 0.59, 0.29, 4),
      zone(cam2.id, 'Z-P3', terraceTables[2].id, 0.39, 0.69, 6),
    ],
  })
  // observational state rows for the mapped tables (empty · full confidence)
  await db.visionTableState.createMany({
    data: [...hallTables.slice(0, 3), ...terraceTables].map((t) => ({
      tableId: t.id, state: 'empty', peopleCount: 0, confidence: 1,
    })),
  })
  // edge ingest key + default detection config
  const { randomBytes } = await import('node:crypto')
  await db.appSetting.createMany({
    data: [
      { key: 'visionIngestKey', value: randomBytes(16).toString('hex') },
      {
        key: 'visionConfig',
        value: JSON.stringify({
          highConfidence: 0.85,
          mediumConfidence: 0.5,
          vacancyDelaySeconds: 45,
          movementDedupeMinutes: 10,
          movementCooldownMinutes: 15,
          serviceDelayMinutes: 10,
          maxEventAgeSeconds: 600,
          manualHoldMinutes: 10,
        }),
      },
    ],
  })
  console.log('✓ vision: 2 cameras, 6 zones, table states + ingest key seeded')

  // R14: WAL journal mode for the freshly seeded database — production
  // default for this platform (readers never block the writer; external
  // backup/analytics readers work alongside the live server). The mode is
  // persistent in the DB file, so every future connection picks it up.
  // (queryRaw, not executeRaw: the PRAGMA returns its resulting mode row.)
  const wal = await db.$queryRawUnsafe<{ journal_mode: string }[]>('PRAGMA journal_mode=WAL')
  console.log(`✓ journal_mode=${wal[0]?.journal_mode} enabled`)

  console.log('Seed complete!')
  console.log('Logins: admin@rms.com/admin123 (PIN 1234) · waiter@rms.com/waiter123 (PIN 1111) · kitchen@rms.com/kitchen123 (PIN 2222)')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
