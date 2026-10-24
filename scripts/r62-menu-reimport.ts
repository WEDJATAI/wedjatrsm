// r62 — V11 MENU REIMPORT (the owner-attached Lilo_Bilingual_Menu_v11_
// 261008_225246.pdf is THE ONLY SOURCE OF TRUTH; both planes + every device).
//
// Owner directive (verbatim): "1-the attached menu is the only source of
// truth. 2-delete all other menu, and implement the attached one with the
// right categories. 3-keep shisha category as it's From mazaj. 4-keep all
// old orders. 5-be sure to push to cloud and to desktop and be sure the
// double sync is working correctly."
//
// WHY: the r57 LELO import split the menu into 27 KITCHEN-STATION categories
// (BREAKFAST / COLD SANDWICHES / OMELET / FRIED POTATOES / VERMICELLI /
// Main Dishes Beef/Chicken/Seafood / Sandwiches Beef/Chicken …). The v11
// PDF's own structure — what the owner edited and expects — is 19 TOC
// sections: Breakfast, Roll Pie Breakfast, Appetizers, Soups, Salads,
// Pan Lilo, Sandwiches, Pasta, Pizza, Main Dishes, Desserts, Extras,
// Fresh Juices, Milkshake, Frappe & Smoothie, Hot Drinks, Iced Coffee &
// Chocolate, Cocktails, Soft Drinks & Yogurt (+ Shisha from mazaj, kept).
//
// WHAT IS REMOVED (and what is deliberately KEPT):
//   REMOVED  · 165 r57-LELO products (ids 1000..1175 minus the 11 history
//             keepers) — the wrong-menu dishes
//             · all 27 r57 station categories (ids 50..76)
//   KEPT     · Category 5 "Shisha" + the 13 MAZAJ-* products (305..317) —
//             the live mazaj integration surface (owner: "keep shisha
//             category as it's From mazaj")
//             · 11 HISTORY-KEEPER products — the r57 dishes referenced by
//             the owner's live orders #2221/#2222/#2223 (order history
//             integrity; owner: "keep all old orders"). They are
//             DEACTIVATED (active=false) + detached (categoryId=null) so
//             the POS menu shows ONLY the v11 menu, while old order items
//             keep resolving to real product rows with real names.
//             · ALL orders + order_items + payments (untouched, both planes)
//             · the generic modifier library (14 groups / 43 modifiers)
//   IMPORTED · 19 v11 categories (ids 100..118, PDF TOC order 10..190)
//             · 187 v11 products (ids 2000..2186, PDF order, bilingual,
//             PDF descriptions + section notes) — scripts/r62/menu-v11.json
//             (text-layer letters + VLM word-order verified, see the
//             builder header)
//
// HOW BOTH PLANES + EVERY DEVICE LEARN ABOUT IT (r55/r57 battle-tested):
//   · local SQLite: direct surgery (single transaction)
//   · Neon cloud: direct surgery (single transaction) + cloud-origin
//     events in the hybrid stream (direction 'out', deviceId 'unbound'),
//     STREAM ORDER = PULL APPLY ORDER:
//       audit create → keeper updates (null category FIRST — FK safety) →
//       product deletes (before their categories) → category deletes →
//       category creates → product creates
//   · every terminal (the owner's desktop, the sandbox) pulls the stream
//     and applies the same cut; r61's CloudUpdateWatcher live-refreshes
//     every open view, and r62's menuReimportAt stamp toasts the dedicated
//     "Menu updated from cloud" notification (a 410-event reimport lands
//     in the bulk-silence band — the stamp punches through it).
//   · revisions stamped above every per-(entity,id) watermark
//
// SAFETY: engine paused for the duration; pre-surgery backups on both
// planes (local VACUUM INTO + full JSON dump of every removed row both
// sides); Neon sequences setval'd past the explicit ids.
import { Pool } from 'pg'
import { createHash, randomUUID } from 'crypto'
import { Database } from 'bun:sqlite'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'

const env = Object.fromEntries(
  readFileSync('.env.deploy-local', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const menu = JSON.parse(readFileSync('scripts/r62/menu-v11.json', 'utf8')) as {
  cats: Array<{ id: number; name: string; nameAr: string; station: string; displayOrder: number }>
  items: Array<{ id: number; nameEn: string; nameAr: string; price: number; descEn: string | null; cat: string }>
}
const KEEP_MAZAJ_IDS = Array.from({ length: 13 }, (_, i) => 305 + i) // MAZAJ-* (shisha, live integration)
// r57 dishes referenced by the owner's live orders #2221/#2222/#2223 — kept
// as INACTIVE history keepers so the order items keep resolving:
const HISTORY_KEEPER_IDS = [1001, 1002, 1003, 1007, 1068, 1070, 1071, 1073, 1076, 1084, 1168]
const KEEP_CAT_ID = 5 // Shisha
const LOCAL_DB = '/home/z/my-project/db/custom.db'
const NOW_ISO = new Date().toISOString()

const log = (m: string) => console.log(`[r62] ${m}`)
let failed = 0
const ok = (c: boolean, l: string) => { console.log(`  ${c ? '✓' : '✗ FAIL'} — ${l}`); if (!c) failed++ }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const canon = (v: any): any => {
  if (v instanceof Date) return v.toISOString()
  if (v === undefined || v === null) return null
  if (Array.isArray(v)) return v.map(canon)
  if (typeof v === 'object') { const o: Record<string, any> = {}; for (const k of Object.keys(v).sort()) o[k] = canon(v[k]); return o }
  return v
}
const cj = (v: any) => JSON.stringify(canon(v))
const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

const ts = NOW_ISO.replace(/[:.]/g, '-').slice(0, 19)
const BK = `backups/r62-menu-${ts}`
mkdirSync(BK, { recursive: true })

const local = new Database(LOCAL_DB)
const pool = new Pool({ connectionString: env.NEON_DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 })

const keepIds = [...KEEP_MAZAJ_IDS, ...HISTORY_KEEPER_IDS]
const inList = `(${keepIds.join(',')})`

// ── 0. pause engine ─────────────────────────────────────────────────
log('pausing engine…')
local.query(`INSERT INTO hybrid_sync_state (key, value, "updatedAt") VALUES ('sync.paused','1',datetime('now')) ON CONFLICT(key) DO UPDATE SET value='1', "updatedAt"=datetime('now')`).run()
await sleep(2500)

// ── 1. backups ──────────────────────────────────────────────────────
log('backups…')
local.query(`VACUUM INTO '${BK}/local-pre.db'`).run()
const removedProducts = local.query(`SELECT * FROM products WHERE id NOT IN ${inList}`).all()
const removedCats = local.query('SELECT * FROM categories WHERE id != 5').all()
const keepersBefore = local.query(`SELECT * FROM products WHERE id IN (${HISTORY_KEEPER_IDS.join(',')})`).all()
const ordersBefore = local.query('SELECT COUNT(*) c FROM orders').get() as any
const itemsBefore = local.query('SELECT COUNT(*) c FROM order_items').get() as any
writeFileSync(`${BK}/removed-local.json`, JSON.stringify({ products: removedProducts, categories: removedCats, keepersBefore }, null, 1))
const client = await pool.connect()
await client.query('BEGIN')
const dump = async (t: string) => (await client.query(`SELECT to_jsonb(x) j FROM ${t} x`)).rows.map((r: any) => r.j)
const cloudDump: Record<string, any[]> = {}
for (const t of ['products', 'categories']) cloudDump[t] = await dump(t)
writeFileSync(`${BK}/removed-neon.json`, JSON.stringify(cloudDump, null, 1))
await client.query('COMMIT')
client.release()
log(`backed up: local ${removedProducts.length} products / ${removedCats.length} cats to remove · ${keepersBefore.length} keepers · orders ${ordersBefore.c} / items ${itemsBefore.c} (must survive) · cloud ${cloudDump.products.length} / ${cloudDump.categories.length}`)

// sanity: the keepers must be exactly the order-referenced r57 products
const orderRefs = new Set(local.query('SELECT DISTINCT product_id p FROM order_items WHERE product_id IS NOT NULL').all().map((r: any) => Number(r.p)))
const mazajSet = new Set(KEEP_MAZAJ_IDS)
const expectedKeep = new Set([...orderRefs].filter((id) => id >= 1000))
ok([...expectedKeep].sort().join(',') === HISTORY_KEEPER_IDS.join(','), `history keepers == order-referenced r57 products (${[...expectedKeep].sort().join(',')})`)
ok([...orderRefs].every((id) => keepIds.includes(id) || id === 305 || mazajSet.has(id)), 'every order-referenced product survives the cut')

const prodCatIds = new Map(menu.items.map((i) => [i.id, menu.cats.find((c) => c.name === i.cat)!.id]))
// audit id must clear BOTH planes' maxima (Neon crons create audit rows the
// desktop never sees)
const localAuditMax = Number((local.query('SELECT MAX(id) m FROM audit_logs').get() as any).m)
const neonAuditMax = Number((await pool.query('SELECT MAX(id) m FROM audit_logs')).rows[0].m)
const auditId = Math.max(localAuditMax, neonAuditMax) + 1
const auditDetails = `v11 menu reimport (only source of truth: Lilo_Bilingual_Menu_v11_261008_225246.pdf): removed ${removedProducts.length} r57-LELO products + ${removedCats.length} station categories; deactivated ${HISTORY_KEEPER_IDS.length} history keepers (order integrity for #2214/#2221/#2222/#2223); kept Shisha + 13 MAZAJ integration products (mazaj); imported ${menu.items.length} products / ${menu.cats.length} categories with the PDF's own category structure (backups/r62-menu-${ts})`

// ── 2. LOCAL surgery (single transaction) ───────────────────────────
log('local surgery…')
local.transaction(() => {
  // keepers: detach + deactivate (before their categories die)
  const dk = local.query(`UPDATE products SET active=0, category_id=NULL WHERE id IN (${HISTORY_KEEPER_IDS.join(',')})`).run()
  ok(dk.changes === HISTORY_KEEPER_IDS.length, `local keepers detached+deactivated: ${dk.changes}/${HISTORY_KEEPER_IDS.length}`)
  const dp = local.query(`DELETE FROM products WHERE id NOT IN ${inList}`).run()
  const dc = local.query('DELETE FROM categories WHERE id != 5').run()
  for (const c of menu.cats) {
    local.query('INSERT INTO categories (id, name, name_ar, display_order, prep_destination, active) VALUES (?,?,?,?,?,1)').run(c.id, c.name, c.nameAr, c.displayOrder, c.station)
  }
  const insP = local.query('INSERT INTO products (id, name, name_ar, category_id, price, cost, is_stockable, is_sellable, sku, image_url, active, low_stock_threshold, stock, sold_out, allergens, dietary, description, created_at) VALUES (?,?,?, ?, ?,0,0,1,NULL,NULL,1,0,0,0,NULL,NULL,?,?)')
  for (const p of menu.items) {
    insP.run(p.id, p.nameEn, p.nameAr, prodCatIds.get(p.id)!, p.price, p.descEn, NOW_ISO)
  }
  ok(dp.changes === removedProducts.length, `local products deleted: ${dp.changes}/${removedProducts.length}`)
  ok(dc.changes === removedCats.length, `local categories deleted: ${dc.changes}/${removedCats.length}`)
})()
const lp = Number((local.query('SELECT COUNT(*) c FROM products').get() as any).c)
const lc = Number((local.query('SELECT COUNT(*) c FROM categories').get() as any).c)
const la = Number((local.query('SELECT COUNT(*) c FROM products WHERE active=1').get() as any).c)
ok(lp === 187 + 13 + 11, `local products now ${lp} (187 v11 + 13 mazaj + 11 keepers = 211)`)
ok(lc === 20, `local categories now ${lc} (19 v11 + shisha = 20)`)
ok(la === 200, `local ACTIVE products ${la} (187 v11 + 13 mazaj = 200 — keepers hidden)`)
const ordersAfter = local.query('SELECT COUNT(*) c FROM orders').get() as any
const itemsAfter = local.query('SELECT COUNT(*) c FROM order_items').get() as any
ok(Number(ordersAfter.c) === Number(ordersBefore.c), `local orders preserved (${ordersAfter.c}/${ordersBefore.c})`)
ok(Number(itemsAfter.c) === Number(itemsBefore.c), `local order items preserved (${itemsAfter.c}/${itemsBefore.c})`)
const dangling = local.query('SELECT COUNT(*) c FROM order_items oi LEFT JOIN products p ON p.id=oi.product_id WHERE oi.product_id IS NOT NULL AND p.id IS NULL').get() as any
ok(Number(dangling.c) === 0, `no dangling order-item product links (${dangling.c})`)

// ── 3. NEON surgery (single transaction) ────────────────────────────
log('neon surgery…')
const c2 = await pool.connect()
await c2.query('BEGIN')
try {
  const dkn = await c2.query(`UPDATE products SET active=false, category_id=NULL WHERE id IN (${HISTORY_KEEPER_IDS.join(',')})`)
  ok(dkn.rowCount === HISTORY_KEEPER_IDS.length, `neon keepers detached+deactivated: ${dkn.rowCount}/${HISTORY_KEEPER_IDS.length}`)
  const dpn = await c2.query(`DELETE FROM products WHERE id NOT IN ${inList}`)
  const dcn = await c2.query('DELETE FROM categories WHERE id != 5')
  for (const cat of menu.cats) {
    await c2.query('INSERT INTO categories (id, name, name_ar, display_order, prep_destination, active) VALUES ($1,$2,$3,$4,$5,true)', [cat.id, cat.name, cat.nameAr, cat.displayOrder, cat.station])
  }
  for (const p of menu.items) {
    await c2.query(`INSERT INTO products (id, name, name_ar, category_id, price, cost, is_stockable, is_sellable, sku, image_url, active, low_stock_threshold, stock, sold_out, allergens, dietary, description, created_at) VALUES ($1,$2,$3,$4,$5,0,false,true,NULL,NULL,true,0,0,false,NULL,NULL,$6,$7)`,
      [p.id, p.nameEn, p.nameAr, prodCatIds.get(p.id)!, p.price, p.descEn, NOW_ISO])
  }
  await c2.query(`INSERT INTO audit_logs (id, user_id, user_name, person_id, person_name, action, entity, entity_id, details, created_at) VALUES ($1,NULL,'system',NULL,NULL,'menu.reimport','product',NULL,$2,$3)`, [auditId, auditDetails, NOW_ISO])
  // sequences past the explicit ids (r38 trap)
  await c2.query(`SELECT setval(pg_get_serial_sequence('products','id'), (SELECT MAX(id) FROM products))`)
  await c2.query(`SELECT setval(pg_get_serial_sequence('categories','id'), (SELECT MAX(id) FROM categories))`)
  await c2.query(`SELECT setval(pg_get_serial_sequence('audit_logs','id'), (SELECT MAX(id) FROM audit_logs))`)
  await c2.query('COMMIT')
  ok(dpn.rowCount === removedProducts.length, `neon products deleted: ${dpn.rowCount}/${removedProducts.length}`)
  ok(dcn.rowCount === removedCats.length, `neon categories deleted: ${dcn.rowCount}/${removedCats.length}`)
} catch (e) {
  await c2.query('ROLLBACK')
  c2.release()
  throw e
}
c2.release()
const npn = Number((await pool.query('SELECT COUNT(*) c FROM products')).rows[0].c)
const ncn = Number((await pool.query('SELECT COUNT(*) c FROM categories')).rows[0].c)
const nan = Number((await pool.query('SELECT COUNT(*) c FROM products WHERE active=true')).rows[0].c)
ok(npn === 211, `neon products now ${npn} (211)`)
ok(ncn === 20, `neon categories now ${ncn} (20)`)
ok(nan === 200, `neon ACTIVE products ${nan} (200)`)

// ── 4. cloud-origin events into the Neon stream ─────────────────────
log('emitting cloud-origin events…')
const c3 = await pool.connect()
await c3.query('BEGIN')
try {
  const maxRev = async (entity: string, entityId: number): Promise<number> => {
    const r = await c3.query(`SELECT COALESCE(MAX(revision),0) rev FROM hybrid_events WHERE entity=$1 AND "entityId"=$2`, [entity, entityId])
    return Number(r.rows[0].rev)
  }
  const emit = async (entity: string, entityId: number, operation: string, payload: any) => {
    const body = cj(payload)
    const rev = (await maxRev(entity, entityId)) + 1
    await c3.query(
      `INSERT INTO hybrid_events ("eventId","deviceId","entity","entityId","operation","revision","payloadHash","payload","direction","status","attempts","createdAt","updatedAt")
       VALUES ($1,'unbound',$2,$3,$4,$5,$6,$7,'out','pending',0,now(),now())`,
      [randomUUID(), entity, entityId, operation, rev, sha(body), body],
    )
  }
  // stream order = apply order on every pulling device
  await emit('AuditLog', auditId, 'create', { id: auditId, action: 'menu.reimport', entity: 'product', entityId: null, details: auditDetails, userId: null, userName: 'system', personId: null, personName: null, createdAt: NOW_ISO })
  // keepers FIRST: null their category before the category rows die (FK order)
  for (const kid of HISTORY_KEEPER_IDS) {
    const row = keepersBefore.find((k: any) => Number(k.id) === kid) as any
    await emit('Product', kid, 'update', { id: kid, name: row?.name ?? `r57 product ${kid}`, nameAr: row?.name_ar ?? null, categoryId: null, price: row?.price ?? 0, cost: 0, isStockable: false, isSellable: true, sku: row?.sku ?? null, imageUrl: null, active: false, lowStockThreshold: 0, stock: 0, soldOut: false, allergens: null, dietary: null, description: row?.description ?? null, createdAt: row?.created_at ?? NOW_ISO })
  }
  for (const row of removedProducts as any[]) await emit('Product', Number(row.id), 'delete', { id: Number(row.id) })
  for (const row of removedCats as any[]) await emit('Category', Number(row.id), 'delete', { id: Number(row.id) })
  for (const cat of menu.cats) await emit('Category', cat.id, 'create', { id: cat.id, name: cat.name, nameAr: cat.nameAr, displayOrder: cat.displayOrder, prepDestination: cat.station, active: true })
  for (const p of menu.items) {
    await emit('Product', p.id, 'create', { id: p.id, name: p.nameEn, nameAr: p.nameAr, categoryId: prodCatIds.get(p.id)!, price: p.price, cost: 0, isStockable: false, isSellable: true, sku: null, imageUrl: null, active: true, lowStockThreshold: 0, stock: 0, soldOut: false, allergens: null, dietary: null, description: p.descEn, createdAt: NOW_ISO })
  }
  await c3.query('COMMIT')
} catch (e) {
  await c3.query('ROLLBACK')
  c3.release()
  throw e
}
c3.release()
const evCount = Number((await pool.query(`SELECT COUNT(*) c FROM hybrid_events WHERE direction='out' AND "deviceId"='unbound' AND "updatedAt" > now() - interval '10 minutes'`)).rows[0].c)
ok(evCount === 1 + HISTORY_KEEPER_IDS.length + removedProducts.length + removedCats.length + menu.cats.length + menu.items.length, `cloud-origin events emitted: ${evCount}`)

// ── 5. resume engine ────────────────────────────────────────────────
local.query(`INSERT INTO hybrid_sync_state (key, value, "updatedAt") VALUES ('sync.paused','0',datetime('now')) ON CONFLICT(key) DO UPDATE SET value='0', "updatedAt"=datetime('now')`).run()
log('engine resumed')

await pool.end()
local.close()
console.log(failed === 0 ? `\n[r62] SURGERY COMPLETE — both planes cut to the v11 menu, events in stream (pull verification next)` : `\n[r62] ${failed} FAILURE(S)`)
process.exit(failed === 0 ? 0 : 1)
