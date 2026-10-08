/**
 * r38 TEST A — PUSH path verification: local create → outbox → Vercel → Neon.
 * Checks: (1) local outbox event status for Customer#17, (2) the row landed
 * in Neon Postgres, (3) the cloud's hybrid_events log recorded it.
 */
import { PrismaClient as PgClient } from '../../pgtmp-client'
import { PrismaPg } from '@prisma/adapter-pg'
import { neonPooledUrl } from '../lib/env-local'
import { db } from '../../src/lib/db'

async function main() {
  // 1) local outbox status
  const local = await db.customer.findUnique({ where: { id: 17 } })
  console.log('LOCAL customer 17:', local ? `${local.name} (active=${local.active})` : 'MISSING')
  const ev = await db.hybridEvent.findMany({
    where: { entity: 'Customer', entityId: 17 },
    orderBy: { id: 'desc' },
    select: { eventId: true, operation: true, revision: true, status: true, attempts: true, lastError: true, ackedAt: true },
  })
  console.log('LOCAL outbox events for Customer#17:', JSON.stringify(ev))
  await db.$disconnect()

  // 2) Neon direct
  const pg = new PgClient({ adapter: new PrismaPg({ connectionString: neonPooledUrl() }) }) // r49: Prisma 7 adapter
  try {
    const c = (await pg.$queryRawUnsafe(
      `SELECT id, name, phone, notes FROM customers WHERE id = 17`,
    )) as Array<{ id: number; name: string; phone: string; notes: string }>
    console.log('NEON customer 17:', c.length ? JSON.stringify(c[0]) : 'MISSING (push not landed!)')
    const he = (await pg.$queryRawUnsafe(
      `SELECT "eventId", operation, revision, status, direction FROM hybrid_events WHERE entity='Customer' AND "entityId"=17 ORDER BY id DESC LIMIT 3`,
    )) as Array<Record<string, unknown>>
    console.log('NEON hybrid_events Customer#17:', JSON.stringify(he))
    const counts = (await pg.$queryRawUnsafe(
      `SELECT (SELECT count(*) FROM customers) customers, (SELECT count(*) FROM users) users, (SELECT count(*) FROM products) products, (SELECT count(*) FROM orders) orders`,
    )) as Array<Record<string, bigint>>
    console.log('NEON totals:', JSON.stringify(counts[0]))
  } finally {
    await pg.$disconnect()
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('FAIL:', e.message)
    process.exit(1)
  })
