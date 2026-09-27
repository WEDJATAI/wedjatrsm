// R29 verification helper — inspect customer demo data (run with bun).
import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

async function main() {
  const cs = await db.customer.findMany({ orderBy: { totalSpent: 'desc' }, take: 14 })
  for (const c of cs) {
    console.log(
      c.id,
      c.name,
      c.phone ?? '—',
      `visits=${c.visits}`,
      `pts=${c.points}`,
      `spent=${c.totalSpent}`,
      `last=${c.lastVisitAt?.toISOString().slice(0, 10) ?? 'never'}`,
      `active=${c.active}`,
      `since=${c.createdAt.toISOString().slice(0, 10)}`,
    )
  }
  const agg = await db.customer.aggregate({ _count: true, _sum: { totalSpent: true } })
  console.log('TOTAL', agg._count, 'SUM_SPENT', agg._sum.totalSpent)
  await db.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
