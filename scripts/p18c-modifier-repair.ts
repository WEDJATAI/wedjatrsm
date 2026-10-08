/**
 * p18c — repair the modifier-28 id collision.
 *
 * p18-menu-organize started explicit modifier ids at 26 assuming a contiguous
 * 1-25 range, but the table had gaps (25 rows, max id 28): id 28 existed as
 * "Extra Sugar" (group 1 Coffee Size) and got silently UPDATED to "Pastrami"
 * while KEEPING group 1 — so Omelet Type lost its Pastrami option and the
 * legacy Coffee Size group shows a wrong label.
 *
 * Repair: restore 28 to its backup state; create Pastrami fresh at id 48
 * inside group 8. Both rides the outbox (Modifier events, neon-identity).
 */
import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'

const prisma = new PrismaClient({ adapter: new PrismaLibSql({ url: (process.env.DATABASE_URL ?? 'file:./db/custom.db').split('?')[0] }) }) // r49: Prisma 7 adapter
const DB_PATH = 'db/custom.db'

const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
function normalize(v: unknown): unknown {
  if (v === undefined || v === null) return null
  if (Array.isArray(v)) return v.map(normalize)
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[k]
      if (val === undefined) continue
      out[k] = normalize(val)
    }
    return out
  }
  return v
}
const canonicalJson = (v: unknown) => JSON.stringify(normalize(v))
function snapRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(row)) {
    out[field] = value instanceof Date ? value.toISOString() : value
  }
  return out
}
async function emit(tx: any, entity: string, entityId: number, operation: string, row: Record<string, unknown>) {
  const stateRow = await tx.hybridSyncState.findUnique({ where: { key: 'local.deviceId' } })
  const deviceId = stateRow?.value ?? 'unbound'
  const payload = canonicalJson(snapRow(row))
  const agg = await tx.hybridEvent.aggregate({ where: { entity, entityId }, _max: { revision: true } })
  const revision = (agg._max.revision ?? 0) + 1
  await tx.hybridEvent.create({
    data: {
      eventId: randomUUID(), deviceId, entity, entityId, operation, revision,
      payload, payloadHash: sha256Hex(payload),
      direction: 'out', status: 'pending',
    },
  })
}

// preflight
{
  const rdb = new Database(DB_PATH, { readonly: true })
  const m28 = rdb.query('select group_id, name from modifiers where id = 28').get() as any
  if (!m28 || m28.name !== 'Pastrami' || m28.group_id !== 1) {
    console.error('ABORT — modifier 28 not in the broken state:', JSON.stringify(m28))
    process.exit(1)
  }
  rdb.close()
}

await prisma.$transaction(async (tx: any) => {
  // 1) restore 28 → Extra Sugar / group 1 / 0 / sort 3
  const restored = await tx.modifier.update({
    where: { id: 28 },
    data: { groupId: 1, name: 'Extra Sugar', nameAr: 'سكر إضافي', priceDelta: 0, active: true, sortOrder: 3 },
  })
  await emit(tx, 'Modifier', 28, 'update', restored)

  // 2) Pastrami fresh at id 48 in group 8 (Omelet Type)
  const exists = await tx.modifier.findUnique({ where: { id: 48 } })
  const pastrami = exists
    ? await tx.modifier.update({ where: { id: 48 }, data: { groupId: 8, name: 'Pastrami', nameAr: 'باستيرامي', priceDelta: 30, active: true, sortOrder: 3 } })
    : await tx.modifier.create({ data: { id: 48, groupId: 8, name: 'Pastrami', nameAr: 'باستيرامي', priceDelta: 30, active: true, sortOrder: 3 } })
  await emit(tx, 'Modifier', 48, exists ? 'update' : 'create', pastrami)
})

// verify
const vdb = new Database(DB_PATH, { readonly: true })
const g8 = vdb.query('select id, name, price_delta from modifiers where group_id = 8 and active = 1 order by sort_order').all()
const m28 = vdb.query('select group_id, name, price_delta from modifiers where id = 28').get()
console.log('VERIFY group 8 (Omelet Type):', JSON.stringify(g8))
console.log('VERIFY modifier 28 restored:', JSON.stringify(m28))
vdb.close()
if (g8.length !== 4) { console.error('ABORT — group 8 must have 4 options'); process.exit(1) }

await prisma.$disconnect()
console.log('DONE — outbox will drain to Neon.')
