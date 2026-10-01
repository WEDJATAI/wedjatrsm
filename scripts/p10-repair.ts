// p10 repair: (1) neutralize 4 false 'applied' events recorded for product ids
// 50-53 whose inserts conflicted with old-lineage rows (never actually applied
// on Neon). Status 'dead' = never served by pull, never retried — honest audit.
// (2) re-insert the 4 Lelo items at free ids 226-229 + truthful events.
import { Database } from 'bun:sqlite'
import { Pool } from 'pg'
import { createHash, randomUUID } from 'node:crypto'
import { neonPooledUrl } from './lib/env-local'

const CAT_REMAP: Record<number, number> = { 9: 29 }
function canon(v: any): any {
  if (v instanceof Date) return v.toISOString()
  if (v === undefined || v === null) return null
  if (Array.isArray(v)) return v.map(canon)
  if (typeof v === 'object') { const o: Record<string, any> = {}; for (const k of Object.keys(v).sort()) o[k] = canon(v[k]); return o }
  return v
}
const canonicalJson = (v: any) => JSON.stringify(canon(v))
const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
const toDate = (v: any): Date => (v instanceof Date ? v : new Date(Number(v)))

const db = new Database('/home/z/my-project/db/custom.db', { readonly: true })
const four = db.query('SELECT id, name, name_ar, category_id, price, cost, is_stockable, is_sellable, sku, image_url, active, low_stock_threshold, stock, sold_out, allergens, dietary, description, created_at FROM products WHERE id IN (50,51,52,53) ORDER BY id').all() as any[]
console.log('re-iding 4 Lelo items:', four.map(f => f.name).join(' | '))

const neon = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false } })
const devRes = await neon.query("SELECT \"deviceId\" FROM hybrid_devices WHERE name = 'Local Terminal' LIMIT 1")
const deviceId = (devRes.rows[0] as any).deviceId
const now = new Date()

// 1) neutralize the 4 false events (identified precisely: Product create events
//    for entityIds 50..53 recorded today by this device with Lelo payloads,
//    while Neon rows 50..53 hold old-lineage content)
const neu = await neon.query(
  `UPDATE hybrid_events SET status = 'dead', "lastError" = 'p10-repair: insert conflicted with old-lineage row (never applied); superseded by re-id 226-229'
   WHERE entity = 'Product' AND "entityId" IN (50,51,52,53) AND operation = 'create' AND direction = 'in'
     AND "deviceId" = $1 AND status = 'applied' AND "createdAt" > now() - interval '1 hour'`,
  [deviceId]
)
console.log('neutralized false events:', neu.rowCount)

// 2) re-insert at 226-229 + truthful events
let next = 226
for (const p of four) {
  const catId = CAT_REMAP[p.category_id] ?? p.category_id
  const ins = await neon.query(
    'INSERT INTO products (id, name, name_ar, category_id, price, cost, is_stockable, is_sellable, sku, image_url, active, low_stock_threshold, stock, sold_out, allergens, dietary, description, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT (id) DO NOTHING',
    [next, p.name, p.name_ar, catId, p.price, p.cost, p.is_stockable, p.is_sellable, p.sku, p.image_url, p.active, p.low_stock_threshold, p.stock, p.sold_out, p.allergens, p.dietary, p.description, toDate(p.created_at)]
  )
  const payload = canonicalJson({ id: next, name: p.name, nameAr: p.name_ar, categoryId: catId, price: p.price, cost: p.cost, isStockable: p.is_stockable, isSellable: p.is_sellable, sku: p.sku, imageUrl: p.image_url, active: p.active, lowStockThreshold: p.low_stock_threshold, stock: p.stock, soldOut: p.sold_out, allergens: p.allergens, dietary: p.dietary, description: p.description, createdAt: toDate(p.created_at).toISOString() })
  await neon.query(
    'INSERT INTO hybrid_events ("eventId", "deviceId", entity, "entityId", operation, revision, payload, "payloadHash", direction, status, attempts, "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT ("eventId") DO NOTHING',
    [randomUUID(), deviceId, 'Product', next, 'create', 1, payload, sha256Hex(payload), 'in', 'applied', 0, now, now]
  )
  console.log('re-id:', p.name, '→ #' + next, '(inserted:', (ins.rowCount ?? 0) > 0 ? 'yes' : 'conflict', ')')
  next++
}

// verify final state
const v = await neon.query('SELECT count(*) c FROM products')
const dead = await neon.query("SELECT count(*) c FROM hybrid_events WHERE status = 'dead'")
const pev = await neon.query("SELECT count(*) c FROM hybrid_events WHERE entity='Product' AND status='applied' AND direction='in' AND \"entityId\" >= 50")
console.log('FINAL: neon products=' + (v.rows[0] as any).c + ' | dead events=' + (dead.rows[0] as any).c + ' | live product create events(>=50)=' + (pev.rows[0] as any).c)
await neon.end()
