import { db } from '../src/lib/db'
const mode = (await db.$queryRawUnsafe('PRAGMA journal_mode')) as Array<{ journal_mode: string }>
console.log('journal_mode NOW:', mode[0]?.journal_mode)
await db.$disconnect()
