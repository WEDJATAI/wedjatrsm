import { db } from '../../src/lib/db'
for (const s of await db.appSetting.findMany()) console.log(`  ${s.key} = ${s.value.slice(0, 80)}`)
await db.$disconnect()
