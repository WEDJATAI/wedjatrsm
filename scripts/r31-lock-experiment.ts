import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'

async function race(url: string, label: string) {
  const holder = new PrismaClient({ adapter: new PrismaLibSql({ url: url.split('?')[0] }) }) // r49: Prisma 7 adapter
  const competitor = new PrismaClient({ adapter: new PrismaLibSql({ url: url.split('?')[0] }) })
  // holder: BEGIN IMMEDIATE, write, sleep 8s (simulating a slow writer)
  const holdPromise = holder.$transaction(async (tx) => {
    await tx.order.update({ where: { id: 1 }, data: { updatedAt: new Date() } })
    console.log(`[${label}] holder has the write lock, sleeping 8s...`)
    await new Promise(r => setTimeout(r, 8000))
    console.log(`[${label}] holder releasing`)
  }, { timeout: 20000 })
  await new Promise(r => setTimeout(r, 300)) // let the holder grab the lock first
  const t0 = Date.now()
  try {
    await competitor.order.update({ where: { id: 1 }, data: { updatedAt: new Date() } })
    console.log(`[${label}] competitor write SUCCEEDED in ${Date.now() - t0}ms`)
  } catch (e) {
    console.log(`[${label}] competitor write FAILED after ${Date.now() - t0}ms: ${(e as Error).message.slice(0, 80)}`)
  }
  await holdPromise
  await holder.$disconnect(); await competitor.$disconnect()
}

await race('file:/home/z/my-project/db/custom.db', 'default-url')
await race('file:/home/z/my-project/db/custom.db?socket_timeout=30000', 'socket30s')
