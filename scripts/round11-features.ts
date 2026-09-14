/**
 * Round 11 — Shisha & station-routing data provisioning (idempotent)
 *
 * 1. Routes existing categories to prep stations:
 *    Starters / Main Courses / Desserts → kitchen (explicit)
 *    Beverages → bar (already set via API smoke test; re-asserted here)
 * 2. Creates the Shisha category (prepDestination 'shisha', bilingual)
 *    with a realistic Egyptian cafe flavor menu.
 * 3. Resets the smoke-test reservation to a clean pending demo booking.
 *
 * Run: bun scripts/round11-features.ts
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

const SHISHA_FLAVORS = [
  { name: 'Double Apple (Maassel)', nameAr: 'تفاحتين', price: 90, cost: 28, sku: 'SH-001' },
  { name: 'Fresh Mint', nameAr: 'نعناع', price: 75, cost: 22, sku: 'SH-002' },
  { name: 'Grape & Mint', nameAr: 'عنب ونعناع', price: 85, cost: 25, sku: 'SH-003' },
  { name: 'Watermelon', nameAr: 'بطيخ', price: 85, cost: 25, sku: 'SH-004' },
  { name: 'Peach', nameAr: 'خوخ', price: 85, cost: 25, sku: 'SH-005' },
  { name: 'Lemon & Mint', nameAr: 'ليمون بالنعناع', price: 80, cost: 24, sku: 'SH-006' },
  { name: 'Mixed Fruit', nameAr: 'فواكه مشكلة', price: 95, cost: 30, sku: 'SH-007' },
  { name: 'Jasmine', nameAr: 'ياسمين', price: 90, cost: 28, sku: 'SH-008' },
  { name: 'Blueberry', nameAr: 'بلوبيري', price: 95, cost: 30, sku: 'SH-009' },
  { name: 'Premium Head Upgrade', nameAr: 'رأس بريميوم', price: 45, cost: 12, sku: 'SH-010' },
]

async function main() {
  console.log('════ Round 11 — shisha & station routing ════')

  // ── 1. Station routing for existing categories ────────────────────
  const routes: Array<[string, string | null]> = [
    ['Starters', 'kitchen'],
    ['Main Courses', 'kitchen'],
    ['Desserts', 'kitchen'],
    ['Beverages', 'bar'],
    ['Ingredients (internal)', null],
  ]
  for (const [name, dest] of routes) {
    const updated = await db.category.updateMany({
      where: { name },
      data: { prepDestination: dest },
    })
    console.log(`  ${name} → ${dest ?? '(default kitchen)'}${updated.count ? ' ✓' : ' (already)'}`)
  }

  // ── 2. Shisha category + flavors ───────────────────────────────────
  let shisha = await db.category.findFirst({ where: { name: 'Shisha' } })
  if (!shisha) {
    shisha = await db.category.create({
      data: {
        name: 'Shisha',
        nameAr: 'شيشة',
        displayOrder: 5,
        prepDestination: 'shisha',
      },
    })
  } else if (shisha.prepDestination !== 'shisha' || !shisha.active) {
    shisha = await db.category.update({
      where: { id: shisha.id },
      data: { prepDestination: 'shisha', active: true },
    })
  }
  console.log(`  category 'Shisha' (id ${shisha.id}) → shisha station ✓`)

  let created = 0
  for (const f of SHISHA_FLAVORS) {
    const existing = await db.product.findFirst({ where: { sku: f.sku } })
    if (existing) continue
    await db.product.create({
      data: {
        name: f.name,
        nameAr: f.nameAr,
        categoryId: shisha.id,
        price: f.price,
        cost: f.cost,
        isSellable: true,
        isStockable: false,
        sku: f.sku,
      },
    })
    created++
  }
  const total = await db.product.count({ where: { categoryId: shisha.id } })
  console.log(`  shisha products: ${created} created, ${total} total ✓`)

  // ── 3. Reset the smoke-test reservation to a clean demo booking ────
  await db.reservation.deleteMany({ where: { orderId: { not: null } } })
  const pendingCount = await db.reservation.count({ where: { status: 'pending' } })
  if (pendingCount === 0) {
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    tomorrow.setHours(19, 30, 0, 0)
    await db.reservation.create({
      data: {
        customerName: 'Nour El-Sayed',
        customerPhone: '0100 123 4567',
        partySize: 4,
        reservedAt: tomorrow,
        status: 'pending',
        notes: 'Birthday — window table if possible',
        createdBy: 'Amina Hassan',
      },
    })
    console.log('  demo booking (tomorrow 19:30, 4 guests) ✓')
  } else {
    console.log(`  ${pendingCount} pending booking(s) kept`)
  }

  console.log('════ Round 11 data provisioning: DONE ════')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
