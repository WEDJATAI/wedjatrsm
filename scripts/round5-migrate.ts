// Round 5 migration — data-only changes (additive, no deletions):
//  1. Restaurant rebrand → "Lilo Cafe and Restaurant" + Arabic name
//  2. Seed the admin item-deletion PIN (changeable in Settings)
// Run: bun scripts/round5-migrate.ts

import { db } from '../src/lib/db'

async function main() {
  // 1) Restaurant identity (upsert keeps history; value editable in Settings)
  await db.appSetting.upsert({
    where: { key: 'restaurantName' },
    update: { value: 'Lilo Cafe and Restaurant' },
    create: { key: 'restaurantName', value: 'Lilo Cafe and Restaurant' },
  })
  await db.appSetting.upsert({
    where: { key: 'restaurantNameAr' },
    update: { value: 'ليلو كافيه ومطعم' },
    create: { key: 'restaurantNameAr', value: 'ليلو كافيه ومطعم' },
  })

  // 2) Item-deletion PIN (admin can change it later in Settings → Security)
  const existingPin = await db.appSetting.findUnique({ where: { key: 'deleteItemPin' } })
  if (!existingPin) {
    await db.appSetting.create({ data: { key: 'deleteItemPin', value: '123456' } })
  }

  const settings = await db.appSetting.findMany()
  console.log('SETTINGS AFTER MIGRATION:', JSON.stringify(settings, null, 2))
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
