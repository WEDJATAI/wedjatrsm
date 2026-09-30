// p10: Lelo house menu → Neon (additive, idempotent).
// - categories 7..28 inserted with local ids; Omelet (local 9) remapped → 29
//   (Neon's 9 is occupied by Shisha from the older cloud seed — never touched)
// - products 50..225 inserted (category remap applied to their rows+payloads)
// - 'in' hybrid_events recorded on Neon so every device can PULL the menu
// - NOTHING else is touched: no orders, no payments, no users, no updates
import { Database } from 'bun:sqlite'
import { Pool } from 'pg'
import { createHash, randomUUID } from 'node:crypto'

const LOCAL = '/home/z/my-project/db/custom.db'
const CATEGORY_REMAP: Record<number, number> = { 9: 29 }

function canon(v: any): any {
  if (v instanceof Date) return v.toISOString()
  if (v === undefined || v === null) return null
  if (Array.isArray(v)) return v.map(canon)
  if (typeof v === 'object') {
    const out: Record<string, any> = {}
    for (const k of Object.keys(v).sort()) { out[k] = canon(v[k]) }
    return out
  }
  return v
}
const canonicalJson = (v: any) => JSON.stringify(canon(v))
const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

const toDate = (v: any): Date => (v instanceof Date ? v : new Date(Number(v)))
const db = new Database(LOCAL, { readonly: true })
const cats = db.query('SELECT id, name, name_ar, display_order, prep_destination, active FROM categories WHERE id BETWEEN 7 AND 28 ORDER BY id').all() as any[]
const prods = db.query('SELECT id, name, name_ar, category_id, price, cost, is_stockable, is_sellable, sku, image_url, active, low_stock_threshold, stock, sold_out, allergens, dietary, description, created_at FROM products WHERE id >= 50 ORDER BY id').all() as any[]
console.log('local Lelo categories:', cats.length, '| local Lelo products:', prods.length)

const neon = new Pool({ connectionString: 'postgresql://neondb_owner:npg_8r0cMUtoipnQ@ep-flat-bonus-au9hoj3b-pooler.c-10.us-east-1.aws.neon.tech/neondb?channel_binding=require&sslmode=require', ssl: { rejectUnauthorized: false } })

// device attribution: this machine's registered terminal on Neon
const devRes = await neon.query("SELECT \"deviceId\" FROM hybrid_devices WHERE name = 'Local Terminal' LIMIT 1")
const deviceId = (devRes.rows[0] as any)?.deviceId
if (!deviceId) { console.error('FATAL: Local Terminal device not found on Neon'); process.exit(1) }
console.log('attributing events to device:', deviceId)

// 0) products.description column (idempotent)
await neon.query('ALTER TABLE products ADD COLUMN IF NOT EXISTS description TEXT')

// 1) categories
let catInserted = 0, catSkipped = 0
for (const c of cats) {
  const nid = CATEGORY_REMAP[c.id] ?? c.id
  const r = await neon.query(
    'INSERT INTO categories (id, name, name_ar, display_order, prep_destination, active) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING',
    [nid, c.name, c.name_ar, c.display_order, c.prep_destination, c.active]
  )
  if (r.rowCount && r.rowCount > 0) catInserted++; else catSkipped++
}

// 2) products + 3) hybrid_events (same pass per product)
let prodInserted = 0, prodSkipped = 0
let evtInserted = 0, evtSkipped = 0
const now = new Date()
for (const p of prods) {
  const catId = CATEGORY_REMAP[p.category_id] ?? p.category_id
  const r = await neon.query(
    'INSERT INTO products (id, name, name_ar, category_id, price, cost, is_stockable, is_sellable, sku, image_url, active, low_stock_threshold, stock, sold_out, allergens, dietary, description, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT (id) DO NOTHING',
    [p.id, p.name, p.name_ar, catId, p.price, p.cost, p.is_stockable, p.is_sellable, p.sku, p.image_url, p.active, p.low_stock_threshold, p.stock, p.sold_out, p.allergens, p.dietary, p.description, toDate(p.created_at)]
  )
  if (r.rowCount && r.rowCount > 0) prodInserted++; else prodSkipped++
  // event payload mirrors the cloud truth (remapped category id)
  const payload = canonicalJson({ id: p.id, name: p.name, nameAr: p.name_ar, categoryId: catId, price: p.price, cost: p.cost, isStockable: p.is_stockable, isSellable: p.is_sellable, sku: p.sku, imageUrl: p.image_url, active: p.active, lowStockThreshold: p.low_stock_threshold, stock: p.stock, soldOut: p.sold_out, allergens: p.allergens, dietary: p.dietary, description: p.description, createdAt: toDate(p.created_at).toISOString() })
  const ev = await neon.query(
    'INSERT INTO hybrid_events ("eventId", "deviceId", entity, "entityId", operation, revision, payload, "payloadHash", direction, status, attempts, "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT ("eventId") DO NOTHING',
    [randomUUID(), deviceId, 'Product', p.id, 'create', 1, payload, sha256Hex(payload), 'in', 'applied', 0, now, now]
  )
  if (ev.rowCount && ev.rowCount > 0) evtInserted++; else evtSkipped++
}

// category events (after product events so product events get lower ids? NO —
// categories must apply BEFORE products on fresh devices → insert them with
// LOWER ids: run category events FIRST. (done below — idempotent regardless)
let catEvtInserted = 0
for (const c of cats) {
  const nid = CATEGORY_REMAP[c.id] ?? c.id
  const payload = canonicalJson({ id: nid, name: c.name, nameAr: c.name_ar, displayOrder: c.display_order, prepDestination: c.prep_destination, active: c.active })
  const ev = await neon.query(
    'INSERT INTO hybrid_events ("eventId", "deviceId", entity, "entityId", operation, revision, payload, "payloadHash", direction, status, attempts, "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT ("eventId") DO NOTHING',
    [randomUUID(), deviceId, 'Category', nid, 'create', 1, payload, sha256Hex(payload), 'in', 'applied', 0, now, now]
  )
  if (ev.rowCount && ev.rowCount > 0) catEvtInserted++
}

// 4) verify
const v1 = await neon.query('SELECT count(*) c FROM products')
const v2 = await neon.query('SELECT count(*) c FROM categories')
const v3 = await neon.query("SELECT count(*) c FROM hybrid_events WHERE entity='Product' AND \"entityId\" >= 50")
const pepperoni = await neon.query("SELECT id, name, price, description FROM products WHERE sku LIKE 'LO-%' ORDER BY id LIMIT 3")
console.log('VERIFY: neon products=' + (v1.rows[0] as any).c + ' categories=' + (v2.rows[0] as any).c + ' product-events(>=50)=' + (v3.rows[0] as any).c)
for (const row of (pepperoni.rows as any[])) console.log('  LO sample:', row.id, row.name, row.price, (row.description || '').slice(0, 40))
console.log('SUMMARY: cats inserted=' + catInserted + ' skipped=' + catSkipped + ' | products inserted=' + prodInserted + ' skipped=' + prodSkipped + ' | product events=' + evtInserted + ' skipped=' + evtSkipped + ' | category events=' + catEvtInserted)
await neon.end()
