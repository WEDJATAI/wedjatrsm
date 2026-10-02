// p14 — MENU UPSCALE (owner directive 2026-10-01: "check the full menu and
// organize it and upscale it, also fix pan lelo to Lilo Pan Dishes").
//
// What this script does (ALL ADDITIVE — no row is deleted, no price changes):
//   1. pre-write backup (VACUUM INTO backups/pre-p14-menu-upscale-<ts>.db)
//   2. preflight assertions (176 LO items, 23 active cats, Pan Lelo present,
//      paired device, cloud target set)
//   3. runs the upgraded importLeloMenu() — the p14 lelo-menu.ts with:
//        · "Pan Lelo" → "Lilo Pan Dishes" (renameFrom)
//        · reorganized category flow (breakfast → starters → mains →
//          desserts → drinks), displayOrder 10..32
//        · Arabic names for every category + all 176 items
//        · descriptions for every item (103 were missing; placeholder
//          "Beef."/"Chicken." lines upgraded to real menu copy)
//   4. mirrors every changed row as a pending 'out' hybrid event so the
//      engine's push cycle drains them to prod (p11e pattern).
//
// ID MAPPING (cloud truth — see p10/p12 worklogs):
//   products: local 50,51,52,53 → Neon 226,227,228,229 (LO-BF-01, LO-CSW-01..03)
//   category: local 9 (Omelet)  → Neon 29 (Neon's 9 is Shisha — NEVER touch)
//   Everything else matches by id. Events for remapped rows carry the NEON
//   id (entityId + payload id) and Omelet product payloads carry categoryId 29
//   so the cloud apply lands on the right rows.
import { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'

const DB_PATH = '/home/z/my-project/db/custom.db'
const BACKUP_DIR = '/home/z/my-project/backups'

const PROD_REMAP: Record<number, number> = { 50: 226, 51: 227, 52: 228, 53: 229 }
const CAT_REMAP: Record<number, number> = { 9: 29 }

// ── helpers (faithful copies of src/lib/hybrid-sync/serialization.ts) ──────
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

function categoryPayload(row: Record<string, unknown>, neonId: number): string {
  return canonicalJson({
    id: neonId,
    name: row.name,
    nameAr: row.name_ar ?? null,
    displayOrder: row.display_order,
    prepDestination: row.prep_destination ?? null,
    active: Boolean(row.active),
  })
}

function productPayload(row: Record<string, unknown>, neonId: number): string {
  return canonicalJson({
    id: neonId,
    name: row.name,
    nameAr: row.name_ar ?? null,
    categoryId: CAT_REMAP[Number(row.category_id)] ?? Number(row.category_id),
    price: row.price,
    cost: row.cost,
    isStockable: Boolean(row.is_stockable),
    isSellable: Boolean(row.is_sellable),
    sku: row.sku ?? null,
    imageUrl: row.image_url ?? null,
    active: Boolean(row.active),
    lowStockThreshold: row.low_stock_threshold,
    stock: row.stock,
    soldOut: Boolean(row.sold_out),
    allergens: row.allergens ?? null,
    dietary: row.dietary ?? null,
    createdAt: new Date(Number(row.created_at)).toISOString(),
    description: row.description ?? null,
  })
}

function fail(msg: string): never {
  console.error('ABORT — ' + msg)
  process.exit(1)
}

// ── 1) pre-write backup ────────────────────────────────────────────────────
const stamp = new Date()
const pad = (n: number) => String(n).padStart(2, '0')
const ts =
  `${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}` +
  `-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`
const backupPath = `${BACKUP_DIR}/pre-p14-menu-upscale-${ts}.db`
{
  const bdb = new Database(DB_PATH)
  bdb.exec(`VACUUM INTO '${backupPath}'`)
  bdb.close()
  console.log('backup written:', backupPath)
}

// ── 2) preflight ───────────────────────────────────────────────────────────
const db = new Database(DB_PATH, { readonly: true })
db.exec('PRAGMA busy_timeout = 10000')

const loCount = (db.query("SELECT COUNT(*) n FROM products WHERE sku LIKE 'LO-%'").get() as any).n
if (loCount !== 176) fail('expected 176 LO products, found ' + loCount)
const activeCats = (db.query('SELECT COUNT(*) n FROM categories WHERE active = 1').get() as any).n
if (activeCats !== 23) fail('expected 23 active categories, found ' + activeCats)
const panLelo = db.query("SELECT id FROM categories WHERE name = 'Pan Lelo'").get() as any
if (!panLelo) fail('category "Pan Lelo" not found — was it renamed already?')
const omelet = db.query("SELECT id FROM categories WHERE name = 'Omelet'").get() as any
if (!omelet || omelet.id !== 9) fail('Omelet category not at local id 9 — remap map needs review')
const device = db.query("SELECT value FROM hybrid_sync_state WHERE key = 'local.deviceId'").get() as any
if (!device?.value) fail('no local.deviceId — device not paired')
const target = db.query("SELECT value FROM app_settings WHERE key = 'sync.targetUrl'").get() as any
if (!target?.value || !String(target.value).includes('wedjatrsm.vercel.app'))
  fail('sync.targetUrl not pointing at prod: ' + target?.value)
const pendingOut = (db.query("SELECT COUNT(*) n FROM hybrid_events WHERE direction='out' AND status='pending'").get() as any).n
if (pendingOut !== 0) fail('outbox not drained (' + pendingOut + ' pending) — let the engine finish before upscaling')
db.close()
console.log('preflight OK: 176 LO items, 23 active cats, Pan Lelo id=' + panLelo.id + ', device ' + String(device.value).slice(0, 8) + '…, target ' + target.value)

// ── 3) run the upgraded import (single source of truth: prisma/lelo-menu) ──
const prisma = new PrismaClient()
const report = await import('../prisma/lelo-menu').then((m) => m.importLeloMenu(prisma))
await prisma.$disconnect()
console.log(
  `import: ${report.itemsCreated} created / ${report.itemsUpdated} refreshed · categories ${report.categoriesCreated} created / ${report.categoriesReused} reused / ${report.categoriesRenamed} renamed`,
)
if (report.itemsCreated !== 0) fail('items created on an established DB — expected pure refresh')
if (report.itemsUpdated !== 176) fail('expected 176 refreshed items, got ' + report.itemsUpdated)
if (report.categoriesRenamed !== 1) fail('expected exactly 1 renamed category (Pan Lelo), got ' + report.categoriesRenamed)

// ── 4) mirror every changed row as pending 'out' events (id-mapped) ───────
const wdb = new Database(DB_PATH)
wdb.exec('PRAGMA busy_timeout = 10000')
const DEVICE_ID = (wdb.query("SELECT value FROM hybrid_sync_state WHERE key = 'local.deviceId'").get() as any).value
const runAt = Date.now()
let events = 0

const insertEvent = (entity: string, neonId: number, payload: string) => {
  const rev =
    (wdb
      .query('SELECT COALESCE(MAX(revision), 0) + 1 r FROM hybrid_events WHERE entity = ? AND entityId = ?')
      .get(entity, neonId) as any).r as number
  wdb.run(
    `INSERT INTO hybrid_events
       (eventId, deviceId, batchId, entity, entityId, operation, revision,
        payloadHash, payload, direction, status, attempts, lastError,
        nextAttemptAt, createdAt, updatedAt, ackedAt)
     VALUES (?, ?, NULL, ?, ?, 'update', ?, ?, ?, 'out', 'pending', 0, NULL, NULL, ?, ?, NULL)`,
    [randomUUID(), DEVICE_ID, entity, neonId, rev, sha256Hex(payload), payload, runAt, runAt],
  )
  events++
}

const emit = wdb.transaction(() => {
  // the 23 house categories (cat 3 reused Desserts + the 22 Lelo rows 7-28)
  const cats = wdb
    .query('SELECT id, name, name_ar, display_order, prep_destination, active FROM categories WHERE id = 3 OR (id BETWEEN 7 AND 28) ORDER BY id')
    .all() as any[]
  if (cats.length !== 23) throw new Error('expected 23 house categories post-import, found ' + cats.length)
  for (const c of cats) insertEvent('Category', CAT_REMAP[c.id] ?? c.id, categoryPayload(c, CAT_REMAP[c.id] ?? c.id))

  // all 176 Lelo items
  const prods = wdb
    .query(`SELECT id, name, name_ar, category_id, price, cost, is_stockable, is_sellable, sku,
                   image_url, active, low_stock_threshold, stock, sold_out, allergens, dietary,
                   created_at, description
            FROM products WHERE sku LIKE 'LO-%' ORDER BY id`)
    .all() as any[]
  if (prods.length !== 176) throw new Error('expected 176 Lelo products post-import, found ' + prods.length)
  for (const p of prods) insertEvent('Product', PROD_REMAP[p.id] ?? p.id, productPayload(p, PROD_REMAP[p.id] ?? p.id))
})

try {
  emit()
} catch (err) {
  fail('event transaction rolled back — ' + (err as Error).message)
}
console.log(`outbox: ${events} pending 'out' update events inserted (176 Product + 23 Category, cloud-id mapped) — engine will drain to prod.`)

// ── 5) post-state verification ─────────────────────────────────────────────
const v = {
  renamed: wdb.query("SELECT id, name, name_ar, display_order FROM categories WHERE id = 15").get() as any,
  omelet: wdb.query('SELECT id, name, name_ar, display_order FROM categories WHERE id = 9').get() as any,
  desserts: wdb.query('SELECT id, display_order, prep_destination FROM categories WHERE id = 3').get() as any,
  withAr: (wdb.query("SELECT COUNT(*) n FROM products WHERE sku LIKE 'LO-%' AND name_ar IS NOT NULL AND name_ar <> ''").get() as any).n,
  withDesc: (wdb.query("SELECT COUNT(*) n FROM products WHERE sku LIKE 'LO-%' AND description IS NOT NULL AND description <> ''").get() as any).n,
  order: (wdb.query('SELECT group_concat(name, " → ") o FROM (SELECT name FROM categories WHERE active = 1 ORDER BY display_order)').get() as any).o,
}
console.log('VERIFY cat 15 (rename):', JSON.stringify(v.renamed))
console.log('VERIFY cat 9 (Omelet):', JSON.stringify(v.omelet))
console.log('VERIFY cat 3 (Desserts):', JSON.stringify(v.desserts))
console.log('VERIFY items with Arabic names:', v.withAr + '/176 | with descriptions:', v.withDesc + '/176')
console.log('VERIFY tab order:', v.order)
wdb.close()

const checks: Array<[string, boolean]> = [
  ['Pan Lelo renamed to Lilo Pan Dishes', v.renamed?.name === 'Lilo Pan Dishes'],
  ['renamed cat keeps Arabic name + slot 18', v.renamed?.name_ar === 'بان ليلو' && v.renamed?.display_order === 18],
  ['Omelet has Arabic name + moved to 11', v.omelet?.name_ar === 'الأومليت' && v.omelet?.display_order === 11],
  ['Desserts resequenced to 24 + kitchen prep', v.desserts?.display_order === 24 && v.desserts?.prep_destination === 'kitchen'],
  ['all 176 items have Arabic names', v.withAr === 176],
  ['all 176 items have descriptions', v.withDesc === 176],
  ['menu flows breakfast→…→drinks', v.order.startsWith('Breakfast') && v.order.endsWith('Yogurt')],
]
let bad = 0
for (const [label, ok] of checks) {
  console.log((ok ? '  ✓ ' : '  ✗ ') + label)
  if (!ok) bad++
}
if (bad > 0) fail(bad + ' verification checks failed')
console.log('p14 local upscale complete — all checks green.')
