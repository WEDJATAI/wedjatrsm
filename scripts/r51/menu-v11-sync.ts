// r51: Lilo bilingual menu v11 (owner upload 2026-10-08,
// Lilo_Bilingual_Menu_v11_261008_225246.pdf) → the RSM menu, applied through
// the LOCAL HTTP API so every write emits its own outbox hybrid event (the
// engine then pushes to Vercel/Neon) + audit row. NOTHING is deleted — the
// no-deletion policy holds (dedup/retire = active:false).
//
// V11 CHANGE SET (verified item-by-item against the live DB dump):
//   1. DEDUP      — the 4 duplicate rows 226-229 (same SKUs LO-BF-01 /
//                  LO-CSW-01..03 as 50-53, a p10/p12-era artifact, BOTH
//                  planes) → active:false. POS was rendering these items
//                  TWICE. 50-53 stay canonical on both planes.
//   2. RENAMES    — v11 rebrand "Lelo"→"Lilo" (7 items) + section-faithful
//                  names (Cheesy Omelet, Mix Cheese Roll Pie +230 EGP —
//                  the ONLY price change in v11, Cheese Fries - Large,
//                  Turkish Coffee/Espresso/Mikato (Single), Light
//                  Frappuccino, Small Water) + exact v11 Arabic names.
//   3. REACTIVATE — 13 v11 items that shipped inactive from the original
//                  p9 import (omelets, roll pies, Creamy Kunafa, Fettuccine
//                  Crepe, the Double coffees, Strong Frappuccino, Large
//                  Water).
//   4. MOVES      — v11 structure: Cold Sandwiches (51-53) into Breakfast
//                  (cat 7); Roll Pies (58-61) into Roll Pie Breakfast
//                  (cat 10); Yogurt (220-225) into Soft Drinks & Yogurt
//                  (cat 27).
//   5. RETIRE     — Vermicelli 114-116 are NOT in v11 → active:false
//                  (documented; one-tap reactivation if the kitchen still
//                  makes them).
//   6. CATEGORIES — rename 11 Appetizers / 25 Frappe & Smoothie /
//                  27 Soft Drinks & Yogurt (v11 section titles); deactivate
//                  the empty sub-category shells 8/9/12 (items live in the
//                  parent sections per v11).
//   7. NEW        — Extras section (v11 page 9): category + 14 products
//                  (LO-EX-01..14), exact v11 prices + Arabic.
//   UNTOUCHED    — the ENTIRE Shisha category (5) incl. all 13 MAZAJ-*
//                  mirror items (owner: "keep the menu of shisha from
//                  mazaj"), Ingredients (6), legacy inactive rows, all
//                  other v11 items that already match exactly.
import { createClient } from '@libsql/client'
import { Database } from 'bun:sqlite'

const LOCAL = 'http://localhost:3000'
const DB_PATH = '/home/z/my-project/db/custom.db'
const ldb = createClient({ url: `file:${DB_PATH}` })
const sdb = new Database(DB_PATH)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let exitCode = 0
const fail = (m: string) => { console.log(`  ✗ ${m}`); exitCode = 1 }

// ── v11 data (from the uploaded PDF, extracted 2026-10-08) ────────────────

const PRODUCT_PATCHES: Array<{ id: number; body: Record<string, unknown>; why: string }> = [
  // 1. dedup — cloud-id duplicates of 50-53 (POS rendered twice)
  { id: 226, body: { active: false }, why: 'dedup: duplicate of #50 Oriental Breakfast (same SKU LO-BF-01)' },
  { id: 227, body: { active: false }, why: 'dedup: duplicate of #51 Chicken Submarine (same SKU LO-CSW-01)' },
  { id: 228, body: { active: false }, why: 'dedup: duplicate of #52 Cold Cut Toast (same SKU LO-CSW-02)' },
  { id: 229, body: { active: false }, why: 'dedup: duplicate of #53 Club Sandwich (same SKU LO-CSW-03)' },
  // 2. renames + exact v11 Arabic (name/price changes only)
  { id: 50, body: { nameAr: 'فطار شرقي' }, why: 'v11 Arabic: فطار شرقي' },
  { id: 51, body: { nameAr: 'ساندوتش سبمارين دجاج', categoryId: 7 }, why: 'v11: cold sandwiches live inside Breakfast; exact Arabic' },
  { id: 52, body: { categoryId: 7 }, why: 'v11: cold sandwiches live inside Breakfast' },
  { id: 53, body: { categoryId: 7 }, why: 'v11: cold sandwiches live inside Breakfast' },
  { id: 54, body: { name: 'Cheesy Omelet', nameAr: 'أومليت بالجبن' }, why: 'v11 name: Cheesy Omelet' },
  { id: 61, body: { name: 'Mix Cheese Roll Pie', nameAr: 'رول باي جبن مشكل', price: 230, categoryId: 10 }, why: 'v11: Mix Cheese Roll Pie 230 (was Roll Pie 210) + own section' },
  { id: 65, body: { name: 'Combo Lilo' }, why: 'v11 rebrand Lelo→Lilo' },
  { id: 71, body: { name: 'Cheese Fries - Large', nameAr: 'بطاطس بالجبنة - كبير' }, why: 'v11 name: Cheese Fries - Large' },
  { id: 77, body: { name: 'Lilo Salad' }, why: 'v11 rebrand Lelo→Lilo' },
  { id: 92, body: { name: 'Lilo Beef Sandwich', nameAr: 'ساندوتش ليلو بيف' }, why: 'v11 rebrand + exact Arabic' },
  { id: 98, body: { name: 'Chicken Lilo', nameAr: 'تشيكن ليلو' }, why: 'v11 rebrand + exact Arabic' },
  { id: 108, body: { name: 'Lilo Beef', nameAr: 'ليلو بيف' }, why: 'v11 rebrand + exact Arabic' },
  { id: 169, body: { name: 'Turkish Coffee (Single)', nameAr: 'قهوة تركي - سنجل' }, why: 'v11: (Single) suffix style' },
  { id: 178, body: { name: 'Espresso (Single)', nameAr: 'إسبريسو - سنجل' }, why: 'v11: (Single) suffix style' },
  { id: 180, body: { name: 'Mikato (Single)', nameAr: 'ميكاتو - سنجل' }, why: 'v11: (Single) suffix style' },
  { id: 193, body: { name: 'Light Frappuccino', nameAr: 'فرابيتشينو لايت' }, why: 'v11 name: Light Frappuccino' },
  { id: 207, body: { name: 'Lilo Cocktail' }, why: 'v11 rebrand Lelo→Lilo' },
  { id: 210, body: { name: 'Blue Lilo' }, why: 'v11 rebrand Lelo→Lilo' },
  { id: 218, body: { name: 'Small Water', nameAr: 'مياه صغيرة' }, why: 'v11 name: Small Water' },
  // 3. reactivations (v11 items that shipped inactive from the p9 import)
  { id: 55, body: { active: true, nameAr: 'أومليت بسطرمة' }, why: 'v11 includes Pastrami Omelet (reactivate)' },
  { id: 56, body: { active: true, nameAr: 'أومليت لحوم مشكلة' }, why: 'v11 includes Mix Beef Omelet (reactivate)' },
  { id: 57, body: { active: true }, why: 'v11 includes Eyes Eggs (reactivate)' },
  { id: 58, body: { active: true, nameAr: 'رول باي لحوم مشكلة', categoryId: 10 }, why: 'v11 roll pie section (reactivate + move)' },
  { id: 59, body: { active: true, nameAr: 'رول باي كيري وبسطرمة', categoryId: 10 }, why: 'v11 roll pie section (reactivate + move)' },
  { id: 60, body: { active: true, categoryId: 10 }, why: 'v11 roll pie section (reactivate + move)' },
  { id: 139, body: { active: true }, why: 'v11 includes Creamy Kunafa (reactivate)' },
  { id: 142, body: { active: true, nameAr: 'كريب فتوتشيني' }, why: 'v11 includes Fettuccine Crepe (reactivate)' },
  { id: 170, body: { active: true, nameAr: 'قهوة تركي - دبل' }, why: 'v11 includes Turkish Coffee Double (reactivate)' },
  { id: 179, body: { active: true, nameAr: 'إسبريسو - دبل' }, why: 'v11 includes Espresso Double (reactivate)' },
  { id: 181, body: { active: true, nameAr: 'ميكاتو - دبل' }, why: 'v11 includes Mikato Double (reactivate)' },
  { id: 194, body: { active: true }, why: 'v11 includes Strong Frappuccino (reactivate)' },
  { id: 219, body: { active: true }, why: 'v11 includes Large Water (reactivate)' },
  // 4. yogurt moves into the v11 "Soft Drinks & Yogurt" section
  { id: 220, body: { categoryId: 27 }, why: 'v11: yogurt inside Soft Drinks & Yogurt' },
  { id: 221, body: { categoryId: 27 }, why: 'v11: yogurt inside Soft Drinks & Yogurt' },
  { id: 222, body: { categoryId: 27 }, why: 'v11: yogurt inside Soft Drinks & Yogurt' },
  { id: 223, body: { categoryId: 27 }, why: 'v11: yogurt inside Soft Drinks & Yogurt' },
  { id: 224, body: { categoryId: 27 }, why: 'v11: yogurt inside Soft Drinks & Yogurt' },
  { id: 225, body: { categoryId: 27 }, why: 'v11: yogurt inside Soft Drinks & Yogurt' },
  // 5. retirements (in the DB, NOT in v11)
  { id: 114, body: { active: false }, why: 'not in v11: Alexandrian Liver Vermicelli (soft-retired, recoverable)' },
  { id: 115, body: { active: false }, why: 'not in v11: Alexandrian Sausage Vermicelli (soft-retired, recoverable)' },
  { id: 116, body: { active: false }, why: 'not in v11: Vermicelli Kebab Halla (soft-retired, recoverable)' },
]

const CATEGORY_PATCHES: Array<{ id: number; body: Record<string, unknown>; why: string }> = [
  { id: 11, body: { name: 'Appetizers', nameAr: 'المقبلات' }, why: 'v11 section: APPETIZERS' },
  { id: 25, body: { name: 'Frappe & Smoothie', nameAr: 'فرابيه وسموثي' }, why: 'v11 section: FRAPPE & SMOOTHIE (yogurt moved out)' },
  { id: 27, body: { name: 'Soft Drinks & Yogurt', nameAr: 'المشروبات الغازية والزبادي' }, why: 'v11 section: SOFT DRINKS & YOGURT' },
  { id: 8, body: { active: false }, why: 'empty shell — v11 has cold sandwiches inside Breakfast' },
  { id: 9, body: { active: false }, why: 'empty shell — v11 has omelets inside Breakfast' },
  { id: 12, body: { active: false }, why: 'empty shell — v11 has fries inside Appetizers' },
]

const EXTRAS: Array<{ sku: string; name: string; nameAr: string; price: number }> = [
  { sku: 'LO-EX-01', name: 'Roquefort Cheese', nameAr: 'جبن ريكفورد', price: 50 },
  { sku: 'LO-EX-02', name: 'Parmesan Cheese', nameAr: 'جبن بارميزان', price: 50 },
  { sku: 'LO-EX-03', name: 'Chicken', nameAr: 'تشيكن', price: 50 },
  { sku: 'LO-EX-04', name: 'Beef Bacon', nameAr: 'بيف بيكون', price: 50 },
  { sku: 'LO-EX-05', name: 'Pepperoni', nameAr: 'بيبروني', price: 50 },
  { sku: 'LO-EX-06', name: 'Potato Puree', nameAr: 'بطاطس بوريه', price: 40 },
  { sku: 'LO-EX-07', name: 'Pastrami', nameAr: 'بسطرمة', price: 55 },
  { sku: 'LO-EX-08', name: 'Mushroom', nameAr: 'مشروم', price: 44 },
  { sku: 'LO-EX-09', name: 'Minced Beef', nameAr: 'لحم مفروم', price: 50 },
  { sku: 'LO-EX-10', name: 'Ranch Sauce', nameAr: 'صوص رانش', price: 25 },
  { sku: 'LO-EX-11', name: 'Sojok', nameAr: 'سجق شرقي', price: 50 },
  { sku: 'LO-EX-12', name: 'Mozzarella', nameAr: 'جبنة موتزاريلا', price: 40 },
  { sku: 'LO-EX-13', name: 'Cheddar Cheese', nameAr: 'جبنة شيدر', price: 40 },
  { sku: 'LO-EX-14', name: 'Hotdog', nameAr: 'هوت دوج', price: 40 },
]

// ── helpers ────────────────────────────────────────────────────────────────

async function waitFor(desc: string, fn: () => Promise<boolean>, timeoutMs = 240_000, everyMs = 4_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) {
      console.log(`  ✓ ${desc} — after ${Math.round((Date.now() - t0) / 1000)}s`)
      return true
    }
    await sleep(everyMs)
  }
  fail(`${desc} — TIMEOUT after ${timeoutMs / 1000}s`)
  return false
}

async function main() {
  console.log('══ r51: Lilo menu v11 → RSM (via local API, hybrid-synced to cloud) ══')

  // 0) pre-write backup (VACUUM INTO — atomic, consistent snapshot)
  const ts = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 17)
  const backupPath = `backups/pre-r51-menu-v11-${ts}.db`
  sdb.exec(`VACUUM INTO '${backupPath}'`)
  console.log(`  ✓ pre-write backup: ${backupPath}`)

  // 1) mint session token server-side (r50 pattern — the API is not under test, the menu write is)
  const { createSessionToken } = await import('../../src/lib/auth')
  const token = await createSessionToken({ userId: 1, email: 'admin@rms.com', name: 'Dr Ihab', role: 'admin', permissions: [], roleName: null, isSuperAdmin: true, personId: null, personName: null })
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(LOCAL + path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const json = await res.json().catch(() => null)
    return { status: res.status, json }
  }

  // 2) preflight: dev server up, engine live, no pending events
  const health = await fetch(LOCAL + '/api/hybrid/live-health').then((r) => r.json()).catch(() => null)
  if (!health) { console.error('FATAL: dev server not reachable'); process.exit(1) }
  console.log(`  ✓ engine live: ${JSON.stringify(health).slice(0, 140)}`)
  const pendingBefore = (await ldb.execute(`SELECT COUNT(*) c FROM hybrid_events WHERE status='pending'`)).rows[0]
  console.log(`  ✓ pending events before: ${Number(pendingBefore?.c ?? 0)}`)

  // 3) apply category patches
  console.log('── categories (renames + retire empty shells) ──')
  for (const c of CATEGORY_PATCHES) {
    const r = await api('PUT', `/api/categories/${c.id}`, c.body)
    if (r.status !== 200) fail(`category ${c.id} (${c.why}): HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`)
    else console.log(`  ✓ cat ${c.id}: ${c.why}`)
  }

  // 4) create the Extras category (local id 29 — Neon max is 28, collision-free)
  console.log('── new Extras section ──')
  const extrasCat = await api('POST', '/api/categories', { name: 'Extras', nameAr: 'إضافات', displayOrder: 105, prepDestination: 'kitchen' })
  let extrasCatId = (extrasCat.json as { category?: { id?: number } })?.category?.id ?? (extrasCat.json as { id?: number })?.id
  if (extrasCat.status !== 200 && extrasCat.status !== 201) {
    // idempotent rerun: the category may already exist
    const existing = (await ldb.execute(`SELECT id FROM categories WHERE name='Extras' LIMIT 1`)).rows[0]
    if (existing) { extrasCatId = Number(existing.id); console.log(`  ✓ Extras already exists (id ${extrasCatId})`) }
    else { fail(`Extras create: HTTP ${extrasCat.status} ${JSON.stringify(extrasCat.json).slice(0, 200)}`) }
  } else console.log(`  ✓ Extras category created (id ${extrasCatId})`)

  // 5) apply product patches
  console.log('── products (dedup · renames · reactivations · moves · retirements) ──')
  let ok = 0, skipped = 0
  for (const p of PRODUCT_PATCHES) {
    const r = await api('PUT', `/api/products/${p.id}`, p.body)
    if (r.status === 200) { ok++; console.log(`  ✓ product ${p.id}: ${p.why}`) }
    else if (r.status === 404) { skipped++; console.log(`  ⚠ product ${p.id} not found (skipped)`) }
    else fail(`product ${p.id} (${p.why}): HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`)
  }
  console.log(`  products patched: ${ok}, skipped: ${skipped}`)

  // 6) create the 14 Extras products (idempotent by SKU)
  console.log('── 14 Extras products (v11 page 9) ──')
  for (const e of EXTRAS) {
    const dupe = (await ldb.execute(`SELECT id FROM products WHERE sku='${e.sku}' LIMIT 1`)).rows[0]
    if (dupe) { console.log(`  ✓ ${e.sku} already exists (id ${dupe.id})`); continue }
    const r = await api('POST', '/api/products', { name: e.name, nameAr: e.nameAr, price: e.price, sku: e.sku, categoryId: extrasCatId, isSellable: true })
    const pid = (r.json as { product?: { id?: number } })?.product?.id
    if (r.status !== 200 && r.status !== 201) fail(`${e.sku} ${e.name}: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`)
    else console.log(`  ✓ ${e.sku} ${e.name} ${e.price} EGP (id ${pid})`)
  }

  // 7) wait for the engine to push every pending out event to the cloud
  console.log('── waiting for engine push (all events → cloud ACK) ──')
  const drained = await waitFor('all pending events ACKED by cloud', async () => {
    const r = (await ldb.execute(`SELECT COUNT(*) c FROM hybrid_events WHERE status='pending'`)).rows[0]
    return Number(r?.c ?? 1) === 0
  })
  if (!drained) {
    const stuck = (await ldb.execute(`SELECT entity, entityId, operation, status, attempts FROM hybrid_events WHERE status='pending' LIMIT 8`)).rows
    console.log('  stuck events:', JSON.stringify(stuck))
  }

  // 8) verify final local state
  console.log('── final verification (local) ──')
  const final = await ldb.execute(`
    SELECT
      (SELECT COUNT(*) FROM products WHERE active=1 AND is_sellable=1) AS activeSellable,
      (SELECT COUNT(*) FROM products WHERE sku LIKE 'LO-EX-%' AND active=1) AS extras,
      (SELECT COUNT(*) FROM products WHERE id IN (226,227,228,229) AND active=0) AS deduped,
      (SELECT COUNT(*) FROM products WHERE id IN (55,56,57,58,59,60,139,142,170,179,181,194,219) AND active=1) AS reactivated,
      (SELECT COUNT(*) FROM products WHERE id IN (51,52,53) AND category_id=7) AS coldSandInBreakfast,
      (SELECT COUNT(*) FROM products WHERE id IN (58,59,60,61) AND category_id=10) AS rollPiesInSection,
      (SELECT COUNT(*) FROM products WHERE id IN (220,221,222,223,224,225) AND category_id=27) AS yogurtMoved,
      (SELECT COUNT(*) FROM products WHERE id IN (114,115,116) AND active=0) AS vermicelliRetired,
      (SELECT COUNT(*) FROM products WHERE sku LIKE 'MAZAJ-%' AND active=1) AS mazajIntact,
      (SELECT COUNT(*) FROM products WHERE sku LIKE 'MAZAJ-%' AND active=0) AS mazajInactive,
      (SELECT price FROM products WHERE id=61) AS mixCheesePrice,
      (SELECT COUNT(*) FROM categories WHERE active=1) AS activeCats
  `)
  const f = final.rows[0] as Record<string, unknown>
  console.log(`  activeSellable=${f.activeSellable} extras=${f.extras}/14 deduped=${f.deduped}/4 reactivated=${f.reactivated}/13`)
  console.log(`  coldSandInBreakfast=${f.coldSandInBreakfast}/3 rollPiesInSection=${f.rollPiesInSection}/4 yogurtMoved=${f.yogurtMoved}/6 vermicelliRetired=${f.vermicelliRetired}/3`)
  console.log(`  mazajShisha active=${f.mazajIntact} (untouched) · mixCheeseRollPie price=${f.mixCheesePrice} · activeCategories=${f.activeCats}`)
  if (Number(f.extras) !== 14) fail('extras count != 14')
  if (Number(f.deduped) !== 4) fail('dedup != 4')
  if (Number(f.reactivated) !== 13) fail('reactivated != 13')
  if (Number(f.coldSandInBreakfast) !== 3) fail('cold sandwiches not in Breakfast')
  if (Number(f.rollPiesInSection) !== 4) fail('roll pies not in section')
  if (Number(f.yogurtMoved) !== 6) fail('yogurt not moved')
  if (Number(f.vermicelliRetired) !== 3) fail('vermicelli not retired')
  if (Number(f.mazajIntact) !== 13) fail('MAZAJ shisha items altered!')
  if (Number(f.mixCheesePrice) !== 230) fail('Mix Cheese Roll Pie price != 230')

  console.log(exitCode === 0 ? '\\nALL R51 MENU-V11 CHECKS PASSED (local)' : '\\nR51 MENU-V11 HAD FAILURES')
  ldb.close(); sdb.close()
  process.exit(exitCode)
}

main().catch((e) => { console.error(e); process.exit(1) })
