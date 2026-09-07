/**
 * Round 3 one-off data migration (idempotent):
 *  - 6-digit PINs for seeded users (login + employee check-in)
 *  - AppSetting: restaurantName (editable by admin)
 *  - Default work shifts (attendance reference only — NOT used for sign-in)
 *  - Example custom role "Accountant" (dashboard + reports)
 *  - Backfill order.guests (1-6) and table shapes variety
 */
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

const SIX_DIGIT_PINS: Record<number, string> = {
  1: '123456', // admin
  2: '111111', // waiter
  3: '222222', // kitchen
}

const SHAPES = ['square', 'round', 'rectangle', 'oval']

async function main() {
  // 1) 6-digit PINs
  for (const [id, pin] of Object.entries(SIX_DIGIT_PINS)) {
    await db.user.update({ where: { id: Number(id) }, data: { pin } })
  }
  // also normalize any other user pins that are not 6 digits
  const others = await db.user.findMany({ where: { id: { notIn: [1, 2, 3] } }, select: { id: true, pin: true } })
  for (const u of others) {
    if (u.pin && !/^\d{6}$/.test(u.pin)) {
      await db.user.update({ where: { id: u.id }, data: { pin: u.pin.padStart(6, '0').slice(-6) } })
    }
  }

  // 2) App settings
  await db.appSetting.upsert({
    where: { key: 'restaurantName' },
    update: {},
    create: { key: 'restaurantName', value: 'Saffron Table' },
  })

  // 3) Shifts
  const shiftCount = await db.shift.count()
  if (shiftCount === 0) {
    await db.shift.createMany({
      data: [
        { name: 'Morning', startTime: '09:00', endTime: '17:00' },
        { name: 'Evening', startTime: '17:00', endTime: '01:00' },
      ],
    })
  }

  // 4) Example custom role
  const accountant = await db.customRole.findFirst({ where: { name: 'Accountant' } })
  if (!accountant) {
    await db.customRole.create({
      data: { name: 'Accountant', permissions: 'dashboard,reports' },
    })
  }

  // 5) Backfill order guests (deterministic 1-6 by id)
  await db.$executeRaw`UPDATE orders SET guests = 1 + (id % 6)`

  // 6) Backfill table shapes (round-robin, keeps floors visually varied)
  const tables = await db.restaurantTable.findMany({ orderBy: { id: 'asc' }, select: { id: true } })
  for (let i = 0; i < tables.length; i++) {
    await db.restaurantTable.update({ where: { id: tables[i].id }, data: { shape: SHAPES[i % SHAPES.length] } })
  }

  const check = await db.$queryRawUnsafe(
    'SELECT (SELECT COUNT(*) FROM app_settings) settings, (SELECT COUNT(*) FROM shifts) shifts, (SELECT COUNT(*) FROM roles) roles, (SELECT COUNT(*) FROM attendance) attendance',
  )
  console.log('round3 migration done:', check)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
