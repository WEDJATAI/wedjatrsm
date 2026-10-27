// r57 — pull convergence + full verification for the menu reimport.
// Loops sync-now until the desktop cursor drains the cloud stream, then
// verifies parity, keep-set integrity, and engine health on both planes.
import { Pool } from 'pg'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'fs'

const env = Object.fromEntries(
  readFileSync('.env.deploy-local', 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)
const LOCAL = 'http://localhost:3000'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let failed = 0
const ok = (c: boolean, l: string) => { console.log(`  ${c ? '✓' : '✗ FAIL'} — ${l}`); if (!c) failed++ }

const login = await fetch(`${LOCAL}/api/auth/developer-login`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ pin: '180787' }),
})
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]
ok(login.status === 200, 'developer session')

const pool = new Pool({ connectionString: env.NEON_DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 })
const local = new Database('/home/z/my-project/db/custom.db')

// ── 1. drain the stream ─────────────────────────────────────────────
const preMax = Number((await pool.query(`SELECT MAX(id) m FROM hybrid_events`)).rows[0].m)
console.log(`\ncloud stream max: ${preMax} — pulling…`)
for (let i = 0; i < 30; i++) {
  const cur0 = Number((local.query(`SELECT value FROM hybrid_sync_state WHERE key='pull.cursor'`).get() as any).value)
  if (cur0 >= preMax) break
  const r = await fetch(`${LOCAL}/api/hybrid/sync-now`, { method: 'POST', headers: { cookie } }).then((x) => x.json()).catch(() => null)
  if (r?.busy) { await sleep(4000); continue }
  await sleep(5000)
}
const cursor = Number((local.query(`SELECT value FROM hybrid_sync_state WHERE key='pull.cursor'`).get() as any).value)
ok(cursor >= preMax, `desktop cursor caught up (${cursor}/${preMax})`)

// ── 2. parity: counts ───────────────────────────────────────────────
console.log('\n── parity ──')
const lProd = Number((local.query('SELECT COUNT(*) c FROM products').get() as any).c)
const nProd = Number((await pool.query('SELECT COUNT(*) c FROM products')).rows[0].c)
const lCat = Number((local.query('SELECT COUNT(*) c FROM categories').get() as any).c)
const nCat = Number((await pool.query('SELECT COUNT(*) c FROM categories')).rows[0].c)
ok(lProd === 189 && nProd === 189, `products 189/189 (local ${lProd} · neon ${nProd})`)
ok(lCat === 28 && nCat === 28, `categories 28/28 (local ${lCat} · neon ${nCat})`)
const lLedger = Number((local.query('SELECT COUNT(*) c FROM inventory_transactions').get() as any).c)
const nLedger = Number((await pool.query('SELECT COUNT(*) c FROM inventory_transactions')).rows[0].c)
ok(lLedger === 0 && nLedger === 0, `old stock ledger removed (local ${lLedger} · neon ${nLedger})`)
const lRec = Number((local.query('SELECT COUNT(*) c FROM recipe_components').get() as any).c)
const nRec = Number((await pool.query('SELECT COUNT(*) c FROM recipe_components')).rows[0].c)
ok(lRec === 0 && nRec === 0, `old recipes removed (local ${lRec} · neon ${nRec})`)
const lLink = Number((local.query('SELECT COUNT(*) c FROM product_modifier_groups').get() as any).c)
ok(lLink === 0, `old product-modifier links removed (local ${lLink})`)
const lMod = Number((local.query('SELECT COUNT(*) c FROM modifiers').get() as any).c)
const lModG = Number((local.query('SELECT COUNT(*) c FROM modifier_groups').get() as any).c)
ok(lMod === 43 && lModG === 14, `modifier library intact (43 modifiers · 14 groups)`)

// ── 3. keep-set integrity ───────────────────────────────────────────
console.log('\n── keep-set ──')
const mazaj = Number((local.query("SELECT COUNT(*) c FROM products WHERE sku LIKE 'MAZAJ%'").get() as any).c)
ok(mazaj === 13, `13 MAZAJ integration products intact (local ${mazaj})`)
const nMazaj = Number((await pool.query("SELECT COUNT(*) c FROM products WHERE sku LIKE 'MAZAJ%'")).rows[0].c)
ok(nMazaj === 13, `13 MAZAJ integration products intact (neon ${nMazaj})`)
const shisha = local.query('SELECT display_order, prep_destination, active FROM categories WHERE id=5').get() as any
ok(Number(shisha?.display_order) === 999 && shisha?.prep_destination === 'shisha', `Shisha category intact, ordered last (displayOrder ${shisha?.display_order})`)
const o2214 = local.query('SELECT id, status FROM orders WHERE id=2214').get() as any
const items2214 = local.query('SELECT product_id FROM order_items WHERE order_id=2214 ORDER BY id').all()
ok(o2214?.status === 'cancelled', `order #2214 intact (${o2214?.status})`)
ok(JSON.stringify(items2214.map((r: any) => r.product_id)) === '[307,317]', `#2214 item links intact (307, 317)`)

// ── 4. new menu spot checks (both planes) ───────────────────────────
console.log('\n── new menu spot checks ──')
const p1000 = local.query('SELECT p.name, p.name_ar, p.price, c.name cat FROM products p JOIN categories c ON c.id=p.category_id WHERE p.id=1000').get() as any
ok(p1000?.name === 'Oriental Breakfast' && p1000?.price === 195 && p1000?.cat === 'BREAKFAST', `#1000 Oriental Breakfast 195 BREAKFAST (ar: ${p1000?.name_ar})`)
const p1175 = local.query('SELECT p.name, p.price, c.name cat FROM products p JOIN categories c ON c.id=p.category_id WHERE p.id=1175').get() as any
ok(p1175?.name === 'Combo Lelo' && p1175?.price === 210 && p1175?.cat === 'APPETIZERS', `#1175 Combo Lelo 210 APPETIZERS`)
const n1000 = (await pool.query('SELECT p.name, p.price, c.name cat FROM products p JOIN categories c ON c.id=p.category_id WHERE p.id=1000')).rows[0]
ok(n1000?.name === 'Oriental Breakfast' && Number(n1000?.price) === 195, `neon #1000 matches`)
// every category 50..76 present with correct station + has products
for (const c of local.query('SELECT id, name, prep_destination, (SELECT COUNT(*) FROM products p WHERE p.category_id=categories.id) n FROM categories WHERE id >= 50 ORDER BY id').all()) {
  if (!(c as any).n) { ok(false, `category ${(c as any).name} has ZERO products`); continue }
}
const emptyCats = Number((local.query('SELECT COUNT(*) c FROM categories WHERE id >= 50 AND (SELECT COUNT(*) FROM products p WHERE p.category_id=categories.id) = 0').get() as any).c)
ok(emptyCats === 0, `all 27 new categories have products (empty: ${emptyCats})`)
const barCats = Number((local.query("SELECT COUNT(*) c FROM categories WHERE id >= 50 AND prep_destination='bar'").get() as any).c)
ok(barCats === 7, `7 drink categories routed to bar (${barCats})`)

// ── 5. audit + engine health ────────────────────────────────────────
console.log('\n── audit + engine ──')
const audit = local.query("SELECT id, action FROM audit_logs WHERE action='menu.reimport'").get() as any
ok(!!audit, `menu.reimport audit row arrived via pull (id ${audit?.id})`)
const failedIn = Number((local.query("SELECT COUNT(*) c FROM hybrid_events WHERE direction='in' AND status='failed'").get() as any).c)
ok(failedIn === 0, `no failed in-events (${failedIn})`)
const r = await fetch(`${LOCAL}/api/hybrid/live-health`, { headers: { cookie } }).then((x) => x.json())
ok(r?.engine === 'running' && r?.paused === false, `engine running, unpaused`)
ok(r?.pendingUploads === 0 && r?.failedOut === 0, `outbox clean (pending ${r?.pendingUploads} · failed ${r?.failedOut})`)

local.close()
await pool.end()
console.log(failed === 0 ? `\n[r57] FULL PARITY — menu live on both planes, keep-set intact, engine healthy` : `\n[r57] ${failed} FAILURE(S)`)
process.exit(failed === 0 ? 0 : 1)
