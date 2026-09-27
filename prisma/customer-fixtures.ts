// ─── R29: CRM demo fixtures — customers across every tier & segment ──
// Idempotent: upserts by phone (unique), never touches a profile that
// already exists. Seed.ts calls this after its own two demo customers so
// future reseeds keep the full CRM story; it also runs standalone:
//   bun prisma/customer-fixtures.ts
// Segments covered: Diamond/Gold/Silver/Bronze, VIP-lapsed (Rania),
// at-risk regulars, brand-new profiles, and one deactivated guest.

import { PrismaClient } from '@prisma/client'

const daysAgo = (n: number): Date => new Date(Date.now() - n * 86_400_000)

type Fixture = {
  name: string
  phone: string
  visits: number
  points: number
  totalSpent: number
  lastVisitDaysAgo: number | null // null = never visited
  memberForDays: number
  active?: boolean
  notes?: string
}

const FIXTURES: Fixture[] = [
  {
    name: 'Dr. Farouk Al-Amin',
    phone: '0100 111 2233',
    visits: 24,
    points: 1840,
    totalSpent: 18450,
    lastVisitDaysAgo: 2,
    memberForDays: 400,
    notes: 'Prefers the corner table by the window. Always orders mint tea after dinner.',
  },
  {
    name: 'Yasmine Adel',
    phone: '0111 234 5678',
    visits: 15,
    points: 925,
    totalSpent: 9260,
    lastVisitDaysAgo: 5,
    memberForDays: 300,
    notes: 'Allergic to peanuts — double-check desserts with the kitchen.',
  },
  {
    name: 'Hossam Fahmy',
    phone: '0122 890 1122',
    visits: 11,
    points: 810,
    totalSpent: 8120,
    lastVisitDaysAgo: 10,
    memberForDays: 250,
  },
  {
    // Gold-tier regular gone quiet — the exact guest a CRM exists to catch
    name: 'Rania Zaki',
    phone: '0100 777 8899',
    visits: 13,
    points: 780,
    totalSpent: 7840,
    lastVisitDaysAgo: 45,
    memberForDays: 350,
    notes: 'Birthday Feb 14. Usually books for 4 on Fridays.',
  },
  {
    name: 'Dalia Nasser',
    phone: '0111 456 7890',
    visits: 8,
    points: 390,
    totalSpent: 3910,
    lastVisitDaysAgo: 12,
    memberForDays: 200,
  },
  {
    name: 'Tarek Mansour',
    phone: '0128 345 6677',
    visits: 6,
    points: 270,
    totalSpent: 2730,
    lastVisitDaysAgo: 20,
    memberForDays: 150,
  },
  {
    name: 'Salma El-Shenawy',
    phone: '0101 234 9988',
    visits: 5,
    points: 255,
    totalSpent: 2580,
    lastVisitDaysAgo: 8,
    memberForDays: 120,
  },
  {
    name: 'Aya Mahmoud',
    phone: '0112 555 4433',
    visits: 3,
    points: 64,
    totalSpent: 642,
    lastVisitDaysAgo: 40,
    memberForDays: 90,
  },
  {
    name: 'Mostafa Kamel',
    phone: '0100 321 6654',
    visits: 2,
    points: 31,
    totalSpent: 312,
    lastVisitDaysAgo: 55,
    memberForDays: 70,
  },
  {
    name: 'Omar Suleiman',
    phone: '0114 888 9900',
    visits: 1,
    points: 28,
    totalSpent: 285,
    lastVisitDaysAgo: 3,
    memberForDays: 5,
  },
  {
    // brand-new profile, no visit yet — the "welcome them in" case
    name: 'Nour Hassan',
    phone: '0127 090 1122',
    visits: 0,
    points: 0,
    totalSpent: 0,
    lastVisitDaysAgo: null,
    memberForDays: 10,
  },
  {
    // deactivated (asked to leave the program)
    name: 'Sherif Gad',
    phone: '0100 555 1919',
    visits: 4,
    points: 120,
    totalSpent: 1210,
    lastVisitDaysAgo: 95,
    memberForDays: 500,
    active: false,
  },
]

/** Upsert every fixture by phone; existing profiles are left untouched. */
export async function ensureCustomerFixtures(db: PrismaClient): Promise<{
  created: number
  present: number
}> {
  let created = 0
  let present = 0
  for (const f of FIXTURES) {
    const existing = await db.customer.findUnique({ where: { phone: f.phone } })
    if (existing) {
      present += 1
      continue
    }
    await db.customer.create({
      data: {
        name: f.name,
        phone: f.phone,
        visits: f.visits,
        points: f.points,
        totalSpent: f.totalSpent,
        lastVisitAt: f.lastVisitDaysAgo == null ? null : daysAgo(f.lastVisitDaysAgo),
        notes: f.notes ?? null,
        active: f.active ?? true,
        createdAt: daysAgo(f.memberForDays),
      },
    })
    created += 1
  }
  return { created, present }
}

// ── standalone runner ──
const isDirectRun =
  typeof process !== 'undefined' &&
  (process.argv[1]?.endsWith('customer-fixtures.ts') ?? false)

if (isDirectRun) {
  const db = new PrismaClient()
  ensureCustomerFixtures(db)
    .then((result) => {
      console.log(`✓ customer fixtures: ${result.created} created, ${result.present} already present`)
    })
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
    .finally(() => db.$disconnect())
}
