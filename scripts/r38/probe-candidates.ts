/**
 * r38 — probe every recovery candidate (health + data richness) to pick the
 * best restore source. Read-only.
 */
import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = '/home/z/my-project'
const CANDIDATES = [
  { label: 'staged(git-HEAD)', file: resolve(ROOT, 'db/restore-pending.db') },
  { label: 'disk(download/)', file: resolve(ROOT, 'download/rsm-platform-database.db') },
]

async function probe(label: string, file: string) {
  if (!existsSync(file)) return console.log(`${label}: MISSING`)
  const p = new PrismaClient({ adapter: new PrismaLibSql({ url: `file:${file}` }), log: ['error'] }) // r49: Prisma 7 adapter
  try {
    const integ = (await p.$queryRawUnsafe('PRAGMA integrity_check')) as Array<{ integrity_check: string }>
    const users = await p.user.count()
    const products = await p.product.count()
    const orders = await p.order.count()
    const payments = await p.payment.count()
    const customers = await p.customer.count()
    const lastOrder = await p.order.findFirst({ orderBy: { id: 'desc' }, select: { id: true, createdAt: true, status: true } })
    const lastEvent = await p.hybridEvent.findFirst({ orderBy: { id: 'desc' }, select: { id: true, createdAt: true, status: true } })
    console.log(
      `${label}: integrity=${integ[0]?.integrity_check} users=${users} products=${products} orders=${orders} payments=${payments} customers=${customers} lastOrder=#${lastOrder?.id}(${lastOrder?.status},${lastOrder?.createdAt?.toISOString?.() ?? lastOrder?.createdAt}) lastOutbox=#${lastEvent?.id}(${lastEvent?.status})`,
    )
  } catch (e) {
    console.log(`${label}: PROBE FAILED — ${e instanceof Error ? e.message : e}`)
  } finally {
    await p.$disconnect()
  }
}

// also list backups/auto
import { readdirSync } from 'node:fs'
const autoDir = resolve(ROOT, 'backups/auto')
if (existsSync(autoDir)) {
  const files = readdirSync(autoDir).filter((f) => f.endsWith('.db')).sort().reverse()
  console.log('backups/auto db files:', files.slice(0, 5).join(', ') || '(empty)')
  for (const f of files.slice(0, 2)) await probe(`auto/${f}`, `${autoDir}/${f}`)
} else {
  console.log('backups/auto: MISSING')
}

for (const c of CANDIDATES) await probe(c.label, c.file)
