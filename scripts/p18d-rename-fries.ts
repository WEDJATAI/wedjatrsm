import { PrismaClient } from '@prisma/client'
import { createHash } from 'node:crypto'
import { randomUUID } from 'node:crypto'

const prisma = new PrismaClient()

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

await prisma.$transaction(async (tx: any) => {
  const row = await tx.product.update({
    where: { id: 71 },
    data: { name: 'Cheese Fries', nameAr: 'بطاطس بالجبنة', description: 'Golden fries topped with melted cheese sauce.' },
  })
  const stateRow = await tx.hybridSyncState.findUnique({ where: { key: 'local.deviceId' } })
  const payload = canonicalJson(snapRow(row))
  const agg = await tx.hybridEvent.aggregate({ where: { entity: 'Product', entityId: 71 }, _max: { revision: true } })
  await tx.hybridEvent.create({
    data: {
      eventId: randomUUID(), deviceId: stateRow?.value ?? 'unbound', entity: 'Product',
      entityId: 71, operation: 'update', revision: (agg._max.revision ?? 0) + 1,
      payload, payloadHash: sha256Hex(payload), direction: 'out', status: 'pending',
    },
  })
  console.log('renamed + event:', row.id, row.name)
})
await prisma.$disconnect()
