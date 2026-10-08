import { db } from '../src/lib/db'
await new Promise(r => setTimeout(r, 1200)) // let the bootstrap land
const mode = (await db.$queryRawUnsafe('PRAGMA journal_mode')) as Array<{ journal_mode: string }>
const bt = (await db.$queryRawUnsafe('PRAGMA busy_timeout')) as Array<{ timeout: bigint }>
const sync = (await db.$queryRawUnsafe('PRAGMA synchronous')) as Array<{ synchronous: number }>
console.log('journal_mode:', mode[0]?.journal_mode, '| busy_timeout:', String(bt[0]?.timeout), '| synchronous:', sync[0]?.synchronous, '(1=NORMAL)')
await db.$disconnect()
