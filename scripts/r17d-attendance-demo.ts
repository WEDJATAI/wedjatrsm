// R17-d demo seeding — the three attendance sessions below were all CREATED
// through the real API (POST /api/attendance/check-in + check-out with PIN
// auth) during verification; this script only adjusts their timestamps to
// realistic shift lengths so the payroll report demonstrates meaningful
// numbers (the live API can only stamp `now`, so a ≥1h session cannot be
// produced end-to-end within a test run). lateMinutes are set consistently
// with the backdated times (Morning shift 09:00, 15-min grace).
//
// Final state:
//   session 8  waiter Sep 15 09:22 → 17:05   (7h43m, 7 min late)
//   session 9  admin  Sep 16 08:55 → 14:30   (5h35m, on time)
//   session 10 waiter Sep 17 09:05 → 13:42:56 (4h37m56s, on time; checkout
//                                              keeps its REAL API timestamp)

import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  const updates: { id: number; checkInAt: Date; checkOutAt: Date; lateMinutes: number }[] = [
    {
      id: 8,
      checkInAt: new Date(2026, 8, 15, 9, 22, 0), // Sep 15 09:22 local
      checkOutAt: new Date(2026, 8, 15, 17, 5, 0), // Sep 15 17:05
      lateMinutes: 7, // 09:22 vs 09:00 shift start − 15 grace
    },
    {
      id: 9,
      checkInAt: new Date(2026, 8, 16, 8, 55, 0), // Sep 16 08:55
      checkOutAt: new Date(2026, 8, 16, 14, 30, 0), // Sep 16 14:30
      lateMinutes: 0, // before shift start
    },
    {
      id: 10,
      checkInAt: new Date(2026, 8, 17, 9, 5, 0), // Sep 17 09:05
      // keep the REAL checkout timestamp (13:42:56.892) — read-modify below
      checkOutAt: new Date(0),
      lateMinutes: 0,
    },
  ]

  for (const u of updates) {
    const existing = await db.attendance.findUnique({ where: { id: u.id } })
    if (!existing) throw new Error(`attendance row ${u.id} not found`)
    const checkOutAt = u.id === 10 ? existing.checkOutAt! : u.checkOutAt
    await db.attendance.update({
      where: { id: u.id },
      data: { checkInAt: u.checkInAt, checkOutAt, lateMinutes: u.lateMinutes },
    })
    const hours = (checkOutAt.getTime() - u.checkInAt.getTime()) / 3_600_000
    console.log(
      `session ${u.id} (user ${existing.userId}): ${u.checkInAt.toISOString()} → ${checkOutAt.toISOString()} = ${hours.toFixed(4)}h, late ${u.lateMinutes}`,
    )
  }

  const rows = await db.attendance.findMany({ orderBy: { id: 'asc' } })
  console.log('FINAL ATTENDANCE:', JSON.stringify(rows, null, 1))
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
