// Round 12 migration — Guest CRM, loyalty, reservations, station routing.
// Additive + idempotent: safe to re-run (all creates are guarded by lookups).
//   1. Loyalty AppSettings (points per EGP / EGP per point)
//   2. Seed 8 customer profiles + attach to historical paid orders
//      (denormalized visits/totalSpend + backfilled 'earn' loyalty ledger)
//   3. Reservations for today + tomorrow (booked / waitlist / seated)
//   4. Product.station routing by category (hot / cold / bar)
// Run: bun scripts/round12-migrate.ts

import { db } from '../src/lib/db'

const POINTS_PER_EGP = 1 // earn rate
const POINT_VALUE_EGP = 0.05 // redemption value per point

type CustomerSeed = {
  name: string
  phone: string
  email?: string
  notes?: string
  birthday?: string // 'MM-DD'
  /** how many historical paid orders to attach (spread deterministically) */
  orders: number
}

const CUSTOMERS: CustomerSeed[] = [
  {
    name: 'Ahmed Hassan',
    phone: '+20 100 123 4567',
    email: 'ahmed.hassan@gmail.com',
    notes: 'Prefers corner tables. Regular weekday lunch.',
    birthday: '04-12',
    orders: 6,
  },
  {
    name: 'Mona El-Sayed',
    phone: '+20 122 555 0193',
    email: 'mona.elsayed@outlook.com',
    notes: 'No coriander — allergy. Loves the fattah.',
    birthday: '11-03',
    orders: 4,
  },
  {
    name: 'Karim Fawzy',
    phone: '+20 111 908 2244',
    notes: 'Business dinners, asks for the VIP zone.',
    orders: 3,
  },
  {
    name: 'Salma Adel',
    phone: '+20 128 774 9010',
    email: 'salma.adel@gmail.com',
    notes: 'Birthday cake for the kids every visit.',
    birthday: '06-21',
    orders: 3,
  },
  {
    name: 'Youssef Nabil',
    phone: '+20 106 332 1188',
    orders: 2,
  },
  {
    name: 'Heba Mostafa',
    phone: '+20 127 445 6620',
    email: 'heba.m@yahoo.com',
    notes: 'Vegetarian — highlight meat-free dishes.',
    orders: 2,
  },
  {
    name: 'Tarek Zaki',
    phone: '+20 110 200 7474',
    notes: 'Pays cash only. Friday family brunch.',
    orders: 1,
  },
  {
    name: 'Nour Ibrahim',
    phone: '+20 155 618 3300',
    orders: 1,
  },
]

async function seedLoyaltySettings() {
  const rows: Array<[string, string]> = [
    ['loyaltyPointsPerEgp', String(POINTS_PER_EGP)],
    ['loyaltyPointValue', String(POINT_VALUE_EGP)],
  ]
  for (const [key, value] of rows) {
    await db.appSetting.upsert({
      where: { key },
      update: {},
      create: { key, value },
    })
  }
  console.log(`loyalty settings ensured (${POINT_VALUE_EGP} EGP/pt, ${POINTS_PER_EGP} pt/EGP)`)
}

async function seedCustomers() {
  // historical paid orders, oldest first — attach deterministically
  const paidOrders = await db.order.findMany({
    where: { status: 'paid', customerId: null },
    orderBy: { closedAt: 'asc' },
    select: { id: true, closedAt: true, subtotalAmount: true, discountAmount: true },
  })

  const existing = await db.customer.count()
  if (existing > 0) {
    console.log(`customers already seeded (${existing}) — skipping attach`)
    return
  }

  // deterministic round-robin over paid orders
  let cursor = 0
  let ledgerRows = 0
  for (const seed of CUSTOMERS) {
    const customer = await db.customer.create({
      data: {
        name: seed.name,
        phone: seed.phone,
        email: seed.email ?? null,
        notes: seed.notes ?? null,
        birthday: seed.birthday ?? null,
      },
    })

    const attached: typeof paidOrders = []
    for (let i = 0; i < seed.orders && cursor < paidOrders.length; i++) {
      attached.push(paidOrders[cursor++])
    }

    let spend = 0
    for (const order of attached) {
      const base = Math.max(0, order.subtotalAmount - (order.discountAmount ?? 0))
      spend += base
      await db.order.update({ where: { id: order.id }, data: { customerId: customer.id } })
      const points = Math.round(base * POINTS_PER_EGP)
      if (points > 0) {
        await db.loyaltyTransaction.create({
          data: {
            customerId: customer.id,
            points,
            kind: 'earn',
            orderId: order.id,
            note: 'Visit spend',
            createdAt: order.closedAt ?? new Date(),
          },
        })
        ledgerRows++
      }
    }

    const points = Math.round(spend * POINTS_PER_EGP)
    await db.customer.update({
      where: { id: customer.id },
      data: { visits: attached.length, totalSpend: Math.round(spend * 100) / 100, loyaltyPoints: points },
    })
    console.log(
      `customer ${seed.name}: ${attached.length} orders, spend ${spend.toFixed(2)}, ${points} pts`,
    )
  }
  console.log(`loyalty ledger backfilled: ${ledgerRows} earn rows`)
}

function at(base: Date, dayOffset: number, hour: number, minute = 0): Date {
  const d = new Date(base)
  d.setDate(d.getDate() + dayOffset)
  d.setHours(hour, minute, 0, 0)
  return d
}

async function seedReservations() {
  const existing = await db.reservation.count()
  if (existing > 0) {
    console.log(`reservations already seeded (${existing}) — skipping`)
    return
  }

  const now = new Date()
  const mainHall = await db.restaurantTable.findMany({
    where: { active: true, floorPlanId: 1 },
    orderBy: { name: 'asc' },
    select: { id: true, name: true },
  })
  const byName = new Map(mainHall.map((t) => [t.name, t.id]))
  const customers = await db.customer.findMany({ select: { id: true, name: true, phone: true } })
  const byCustomerName = new Map(customers.map((c) => [c.name, c]))
  const ahmed = byCustomerName.get('Ahmed Hassan')
  const mona = byCustomerName.get('Mona El-Sayed')
  const karim = byCustomerName.get('Karim Fawzy')

  const rows: Array<{
    customerName: string
    phone?: string | null
    guests: number
    reservedAt: Date
    tableId?: number | null
    zone?: string | null
    status: string
    source: string
    notes?: string
    waitQuoted?: number | null
    customerId?: number | null
  }> = [
    // past today — seated
    {
      customerName: 'Ahmed Hassan',
      phone: ahmed?.phone,
      guests: 2,
      reservedAt: at(now, 0, 13, 0),
      tableId: byName.get('2') ?? null,
      zone: 'Window Seats',
      status: 'seated',
      source: 'regular',
      notes: 'Corner table as usual',
      customerId: ahmed?.id ?? null,
    },
    {
      customerName: 'Salma Adel',
      guests: 5,
      reservedAt: at(now, 0, 13, 30),
      tableId: byName.get('4') ?? null,
      status: 'seated',
      source: 'phone',
      notes: 'High chair for the little one',
      customerId: byCustomerName.get('Salma Adel')?.id ?? null,
    },
    // upcoming today — booked
    {
      customerName: 'Karim Fawzy',
      phone: karim?.phone,
      guests: 4,
      reservedAt: at(now, 0, 20, 0),
      tableId: byName.get('3') ?? null,
      zone: 'VIP',
      status: 'booked',
      source: 'phone',
      notes: 'Business dinner — quiet table',
      customerId: karim?.id ?? null,
    },
    {
      customerName: 'Mona El-Sayed',
      phone: mona?.phone,
      guests: 3,
      reservedAt: at(now, 0, 21, 0),
      tableId: null,
      zone: 'Terrace',
      status: 'booked',
      source: 'phone',
      notes: 'No coriander anywhere on the plates',
      customerId: mona?.id ?? null,
    },
    // walk-in waitlist tonight
    {
      customerName: 'Youssef Nabil',
      guests: 2,
      reservedAt: at(now, 0, 19, 45),
      status: 'waitlist',
      source: 'walk_in',
      notes: 'Quoted 25 min at the door',
      waitQuoted: 25,
    },
    {
      customerName: 'Nour Ibrahim',
      guests: 6,
      reservedAt: at(now, 0, 20, 15),
      status: 'waitlist',
      source: 'walk_in',
      notes: 'Large party — may need merged tables',
      waitQuoted: 40,
    },
    // tomorrow
    {
      customerName: 'Tarek Zaki',
      guests: 6,
      reservedAt: at(now, 1, 13, 0),
      tableId: byName.get('4') ?? null,
      status: 'booked',
      source: 'phone',
      notes: 'Friday family brunch',
    },
    {
      customerName: 'Heba Mostafa',
      guests: 2,
      reservedAt: at(now, 1, 19, 30),
      zone: 'Terrace',
      status: 'booked',
      source: 'phone',
      notes: 'Vegetarian menu highlights',
    },
  ]

  for (const row of rows) {
    await db.reservation.create({
      data: {
        customerName: row.customerName,
        phone: row.phone ?? null,
        guests: row.guests,
        reservedAt: row.reservedAt,
        tableId: row.tableId ?? null,
        zone: row.zone ?? null,
        status: row.status,
        source: row.source,
        notes: row.notes ?? null,
        waitQuoted: row.waitQuoted ?? null,
        customerId: row.customerId ?? null,
        seatedAt: row.status === 'seated' ? new Date() : null,
      },
    })
  }
  console.log(`reservations seeded: ${rows.length} (today + tomorrow)`)
}

async function seedStations() {
  // Route printed prep tickets by category: hot line / cold line / bar.
  const cats = await db.category.findMany({ select: { id: true, name: true } })
  const byName = new Map(cats.map((c) => [c.name.toLowerCase(), c.id]))
  const stationFor = (catId: number | null): string | null => {
    if (catId == null) return null
    if (catId === byName.get('beverages')) return 'bar'
    if (catId === byName.get('starters') || catId === byName.get('salads')) return 'cold'
    if (catId === byName.get('desserts')) return 'dessert'
    if (catId === byName.get('main courses') || catId === byName.get('mains')) return 'hot'
    return null
  }
  const products = await db.product.findMany({
    where: { isSellable: true, active: true },
    select: { id: true, categoryId: true },
  })
  let updated = 0
  for (const p of products) {
    const station = stationFor(p.categoryId)
    if (station) {
      await db.product.update({ where: { id: p.id }, data: { station } })
      updated++
    }
  }
  console.log(`station routing set on ${updated} sellable products`)
}

async function main() {
  await seedLoyaltySettings()
  await seedCustomers()
  await seedReservations()
  await seedStations()
  console.log('round12 migration complete')
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
