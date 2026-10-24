// p11-e — OLD demo menu retirement (DEACTIVATION ONLY — additive-safe).
//
// Owner authorized removing the OLD menu. Platform rule: rows are NEVER
// deleted (old orders/payments/inventory reference old product ids — history
// stays intact); "removal" = active=0.
//
// RECON (verified live 2026-10-01 against db/custom.db, see worklog p11-e):
//   categories 1-5  = demo menu (Starters/Main Courses/Desserts/Beverages/Shisha)
//   category   6    = Ingredients (internal), already active=0 → UNTOUCHED
//   categories 7-28 = the 22 Lelo categories (Breakfast→Yogurt) → UNTOUCHED
//   products in cats 1-5 = 40 rows:
//     • 30 demo items (ids 20-49, skus ST-/MN-/DS-/BV-/SH-*) → DEACTIVATED
//     • 10 LELO desserts (ids 138-147, skus LO-DE-01..10) living in the
//       REUSED demo "Desserts" category (p9: "demo 'Desserts' REUSED — avoids
//       duplicate POS tabs") → part of the REAL house menu → STAY ACTIVE
//   → category 3 "Desserts" is NOT old-menu-only: it hosts the live Lelo
//     dessert section, so it stays active. Only categories 1,2,4,5 (which
//     contain zero Lelo items) are deactivated.
//
// Hybrid sync: each deactivated row also gets a pending 'out' update event in
// hybrid_events, mirroring src/lib/hybrid-sync/outbox.ts exactly (canonical
// JSON payload of the post-update Prisma row, sha256 payloadHash, per-entity
// revision = max+1, deviceId from hybrid_sync_state, status 'pending').
import { Database } from 'bun:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { readdirSync, statSync } from 'node:fs'

const DB_PATH = '/home/z/my-project/db/custom.db'
const BACKUP_DIR = '/home/z/my-project/backups'

// ── helpers ────────────────────────────────────────────────────────────────
const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

// canonicalJson — faithful copy of src/lib/hybrid-sync/serialization.ts
// (object keys recursively sorted, undefined dropped, no whitespace).
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

/** Prisma Category row shape (camelCase) ← sqlite snake_case row. */
function categoryPayload(row: Record<string, unknown>): string {
  return canonicalJson({
    id: row.id,
    name: row.name,
    nameAr: row.name_ar ?? null,
    displayOrder: row.display_order,
    prepDestination: row.prep_destination ?? null,
    active: Boolean(row.active),
  })
}

/** Prisma Product row shape (camelCase, createdAt → ISO) ← sqlite row. */
function productPayload(row: Record<string, unknown>): string {
  return canonicalJson({
    id: row.id,
    name: row.name,
    nameAr: row.name_ar ?? null,
    categoryId: row.category_id,
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

// ── state snapshot ─────────────────────────────────────────────────────────
function snapshot(db: Database) {
  const q = (sql: string): any => db.query(sql).get() as any
  return {
    catsOldOnly: q('SELECT COUNT(*) n, SUM(active) a FROM categories WHERE id IN (1,2,4,5)'),
    cat3Shared: q('SELECT id, name, active FROM categories WHERE id = 3'),
    cat6: q('SELECT COUNT(*) n, SUM(active) a FROM categories WHERE id = 6'),
    catsLelo: q('SELECT COUNT(*) n, SUM(active) a FROM categories WHERE id BETWEEN 7 AND 28'),
    prodsOld: q(
      "SELECT COUNT(*) n, SUM(active) a FROM products WHERE category_id BETWEEN 1 AND 5 AND sku NOT LIKE 'LO-%'",
    ),
    prodsLeloInCat3: q(
      "SELECT COUNT(*) n, SUM(active) a FROM products WHERE category_id = 3 AND sku LIKE 'LO-%'",
    ),
    prodsLeloTotal: q("SELECT COUNT(*) n, SUM(active) a FROM products WHERE sku LIKE 'LO-%'"),
    prodsLeloSellable: q(
      "SELECT COUNT(*) n FROM products WHERE sku LIKE 'LO-%' AND is_sellable = 1 AND active = 1",
    ),
    prodsIngredients: q('SELECT COUNT(*) n, SUM(active) a FROM products WHERE category_id = 6'),
    prodsIdGte50: q('SELECT COUNT(*) n, SUM(active) a FROM products WHERE id >= 50'),
    prodsActiveSellableTotal: q(
      'SELECT COUNT(*) n FROM products WHERE active = 1 AND is_sellable = 1',
    ),
  }
}

function printState(label: string, s: ReturnType<typeof snapshot>) {
  console.log('── ' + label + ' ──')
  console.log(
    `  categories: old-only(1,2,4,5) ${s.catsOldOnly.a}/${s.catsOldOnly.n} active | cat3 "Desserts" (shared) active=${s.cat3Shared.active} | cat6 Ingredients ${s.cat6.a}/${s.cat6.n} active | Lelo(7-28) ${s.catsLelo.a}/${s.catsLelo.n} active`,
  )
  console.log(
    `  products:   old demo (cats1-5, non-LO) ${s.prodsOld.a}/${s.prodsOld.n} active | Lelo in cat3 (LO-DE) ${s.prodsLeloInCat3.a}/${s.prodsLeloInCat3.n} active | Lelo total ${s.prodsLeloTotal.a}/${s.prodsLeloTotal.n} active | ingredients (cat6) ${s.prodsIngredients.a}/${s.prodsIngredients.n} active | id>=50 ${s.prodsIdGte50.a}/${s.prodsIdGte50.n} active`,
  )
  console.log(`  POS catalog (/api/products?sellable=1 shape): ${s.prodsActiveSellableTotal.n} active sellable (Lelo: ${s.prodsLeloSellable.n})`)
}

function fail(msg: string): never {
  console.error('ABORT — ' + msg)
  process.exit(1)
}

// ── 0) backup gate ─────────────────────────────────────────────────────────
const backups = readdirSync(BACKUP_DIR).filter((f) => f.startsWith('pre-p11e-menu-retire-'))
if (backups.length === 0) fail('no pre-p11e-menu-retire-* backup found in ' + BACKUP_DIR)
for (const f of backups) {
  const size = statSync(BACKUP_DIR + '/' + f).size
  console.log(`backup present: ${f} (${(size / 1024).toFixed(1)} KB)`)
  if (size <= 500 * 1024) fail('backup too small (<500KB): ' + f)
}

// ── 1) connect + BEFORE state ──────────────────────────────────────────────
const db = new Database(DB_PATH)
db.exec('PRAGMA busy_timeout = 10000')

const before = snapshot(db)
printState('BEFORE', before)

// ── 2) preflight assertions (no writes unless everything matches) ─────────
const catRows = db
  .query('SELECT id, active FROM categories WHERE id BETWEEN 1 AND 28 ORDER BY id')
  .all() as any[]
if (catRows.length !== 28) fail('expected 28 categories, found ' + catRows.length)
for (const c of catRows) {
  const id = c.id as number
  let expect: number
  if (id <= 5) expect = 1 // cats 1-5 (incl. shared 3) currently active
  else if (id === 6) expect = 0 // ingredients already inactive
  else expect = 1 // 22 Lelo categories
  if (c.active !== expect) fail(`category ${id} active=${c.active}, expected ${expect}`)
}

const oldIds = (
  db
    .query("SELECT id FROM products WHERE category_id BETWEEN 1 AND 5 AND sku NOT LIKE 'LO-%' ORDER BY id")
    .all() as any[]
).map((r) => r.id as number)
const idLt50 = (
  db
    .query('SELECT id FROM products WHERE category_id BETWEEN 1 AND 5 AND id < 50 ORDER BY id')
    .all() as any[]
).map((r) => r.id as number)
if (oldIds.length !== 30) fail('expected 30 old demo products in cats 1-5, found ' + oldIds.length)
if (JSON.stringify(oldIds) !== JSON.stringify(idLt50))
  fail('old-product set mismatch: sku NOT LO-% vs id<50 differ — inspect before writing')

const leloInCat3 = db
  .query("SELECT id, sku, active, is_sellable FROM products WHERE category_id = 3 AND sku LIKE 'LO-%' ORDER BY id")
  .all() as any[]
if (leloInCat3.length !== 10) fail('expected 10 Lelo desserts (LO-DE-*) in cat 3, found ' + leloInCat3.length)
if (!leloInCat3.every((p) => p.sku.startsWith('LO-DE-'))) fail('unexpected non-LO-DE sku inside cat 3 Lelo set')
if (!leloInCat3.every((p) => p.active === 1 && p.is_sellable === 1))
  fail('a Lelo dessert in cat 3 is not active+sellable — inspect before writing')

const loTotal = (db.query("SELECT COUNT(*) n FROM products WHERE sku LIKE 'LO-%'").get() as any).n
if (loTotal !== 176) fail('expected 176 Lelo products, found ' + loTotal)
const loActive = (db.query("SELECT COUNT(*) n FROM products WHERE sku LIKE 'LO-%' AND active = 1").get() as any).n
if (loActive !== 176) fail('expected all 176 Lelo products active, found ' + loActive)
const loOutside = (
  db.query("SELECT id FROM products WHERE sku LIKE 'LO-%' AND category_id NOT BETWEEN 1 AND 28").all() as any[]
).length
if (loOutside !== 0) fail('Lelo products exist outside categories 1-28?!')

// cats 1,2,4,5 must contain ZERO Lelo items (cat 3 is the only shared one)
const loInOldOnly = (
  db.query("SELECT COUNT(*) n FROM products WHERE category_id IN (1,2,4,5) AND sku LIKE 'LO-%'").get() as any
).n
if (loInOldOnly !== 0) fail('categories 1,2,4,5 contain Lelo items — re-derive the plan first')

const ingredientCount = (db.query('SELECT COUNT(*) n FROM products WHERE category_id = 6').get() as any).n
if (ingredientCount !== 19) fail('expected 19 ingredient products in cat 6, found ' + ingredientCount)

const notActiveOld = (db
  .query("SELECT COUNT(*) n FROM products WHERE category_id BETWEEN 1 AND 5 AND sku NOT LIKE 'LO-%' AND active <> 1")
  .get() as any).n
if (notActiveOld !== 0) fail('some old demo products are already inactive — inspect before writing')

console.log('preflight OK: 30 old demo products + categories 1,2,4,5 to deactivate; cat 3 + 10 LO-DE desserts stay; 176 Lelo / 19 ingredients untouched.')

// ── 3) THE write — one transaction, two UPDATEs + mirrored outbox events ───
const deviceIdRow = db
  .query("SELECT value FROM hybrid_sync_state WHERE key = 'local.deviceId'")
  .get() as any
const DEVICE_ID = deviceIdRow?.value ?? 'unbound'
console.log('outbox deviceId: ' + DEVICE_ID)

let eventsInserted = 0
const runAt = Date.now() // createdAt/updatedAt stamp shared by all mirrored events

const run = db.transaction(() => {
  // (a) deactivate the 4 old-menu-only categories
  const catRes = db.run(
    'UPDATE categories SET active = 0 WHERE id IN (1,2,4,5)',
  )
  if (catRes.changes !== 4) throw new Error('category UPDATE changed ' + catRes.changes + ' rows, expected 4')

  // (b) deactivate the 30 old demo products in cats 1-5 (Lelo LO-* excluded)
  const prodRes = db.run(
    "UPDATE products SET active = 0 WHERE category_id BETWEEN 1 AND 5 AND sku NOT LIKE 'LO-%'",
  )
  if (prodRes.changes !== 30) throw new Error('product UPDATE changed ' + prodRes.changes + ' rows, expected 30')

  // (c) mirrored hybrid outbox events — one 'update' per deactivated row,
  //     post-update row as canonical payload, revision = max+1 per entity row
  const insertEvent = (entity: string, entityId: number, payload: string) => {
    const rev =
      (db
        .query('SELECT COALESCE(MAX(revision), 0) + 1 r FROM hybrid_events WHERE entity = ? AND entityId = ?')
        .get(entity, entityId) as any).r as number
    db.run(
      `INSERT INTO hybrid_events
         (eventId, deviceId, batchId, entity, entityId, operation, revision,
          payloadHash, payload, direction, status, attempts, lastError,
          nextAttemptAt, createdAt, updatedAt, ackedAt)
       VALUES (?, ?, NULL, ?, ?, 'update', ?, ?, ?, 'out', 'pending', 0, NULL, NULL, ?, ?, NULL)`,
      [randomUUID(), DEVICE_ID, entity, entityId, rev, sha256Hex(payload), payload, runAt, runAt],
    )
    eventsInserted++
    console.log(`  hybrid_events + ${entity}#${entityId} rev ${rev} (update, out, pending)`)
  }

  const catRowsAfter = db
    .query('SELECT id, name, name_ar, display_order, prep_destination, active FROM categories WHERE id IN (1,2,4,5) ORDER BY id')
    .all() as any[]
  for (const row of catRowsAfter) insertEvent('Category', row.id, categoryPayload(row))

  const placeholders = oldIds.map(() => '?').join(',')
  const prodRowsAfter = db
    .query(
      `SELECT id, name, name_ar, category_id, price, cost, is_stockable, is_sellable, sku,
              image_url, active, low_stock_threshold, stock, sold_out, allergens, dietary,
              created_at, description
       FROM products WHERE id IN (${placeholders}) ORDER BY id`,
    )
    .all(...oldIds) as any[]
  if (prodRowsAfter.length !== 30) throw new Error('post-update product read returned ' + prodRowsAfter.length + ' rows')
  for (const row of prodRowsAfter) insertEvent('Product', row.id, productPayload(row))
})

try {
  run()
} catch (err) {
  fail('transaction rolled back — ' + (err as Error).message)
}
console.log(`transaction committed: 4 categories + 30 products deactivated, ${eventsInserted} hybrid_events inserted (status pending, direction out).`)

// ── 4) AFTER state + verification ──────────────────────────────────────────
const after = snapshot(db)
printState('AFTER', after)

const checks: Array<[string, boolean]> = [
  ['cats 1,2,4,5 all inactive', after.catsOldOnly.a === 0 && after.catsOldOnly.n === 4],
  ['cat 3 "Desserts" still active (hosts LO-DE section)', after.cat3Shared.active === 1],
  ['cat 6 untouched (inactive category, 19 products)', after.cat6.a === 0 && after.prodsIngredients.n === 19 && after.prodsIngredients.a === 19],
  ['cats 7-28 all active (22)', after.catsLelo.a === 22 && after.catsLelo.n === 22],
  ['30 old demo products inactive', after.prodsOld.a === 0 && after.prodsOld.n === 30],
  ['10 Lelo desserts in cat 3 still active', after.prodsLeloInCat3.a === 10 && after.prodsLeloInCat3.n === 10],
  ['all 176 Lelo products still active', after.prodsLeloTotal.a === 176 && after.prodsLeloTotal.n === 176],
  ['all id>=50 products still active (176)', after.prodsIdGte50.a === 176 && after.prodsIdGte50.n === 176],
  ['POS catalog = exactly the 176 Lelo items', after.prodsActiveSellableTotal.n === 176 && after.prodsLeloSellable.n === 176],
  ['34 pending out events inserted (4 Category + 30 Product)', eventsInserted === 34],
]
let allOk = true
for (const [label, ok] of checks) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) allOk = false
}
const evtRows = db
  .query(
    "SELECT entity, COUNT(*) n FROM hybrid_events WHERE createdAt = ? AND operation='update' AND direction='out' AND status='pending' GROUP BY entity ORDER BY entity",
  )
  .all(runAt) as any[]
console.log('inserted events by entity (createdAt=' + runAt + '): ' + JSON.stringify(evtRows))

const quickCheck = db.query('PRAGMA quick_check').get() as any
console.log('integrity quick_check: ' + JSON.stringify(quickCheck))

db.close()
if (!allOk) fail('POST-CONDITION FAILURE — see FAILED checks above (DB still has the pre-change backup)')
console.log('DONE — old demo menu retired (deactivated, zero deletions); Lelo house menu fully intact.')
