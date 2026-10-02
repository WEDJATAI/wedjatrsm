/** p18b — Neon link inserts (product_modifier_groups) after outbox drain. */
import { readFileSync } from 'node:fs'
import { Client } from 'pg'

const neonUrl = readFileSync('.env.deploy-local', 'utf8').match(/^NEON_DATABASE_URL=(.+)$/m)![1].trim()
const pg = new Client({ connectionString: neonUrl })
await pg.connect()

// sanity: the 8 new groups landed
const g = await pg.query('select id, name, name_ar from modifier_groups where id between 8 and 15 order by id')
console.log('neon groups 8-15:')
for (const r of g.rows) console.log(' ', r.id, r.name, '|', r.name_ar)
if (g.rows.length !== 8) { console.error('ABORT — groups not fully synced'); process.exit(1) }

// links (product ids are identity-mapped for these 7 canonical products)
const LINKS: Array<[number, number]> = [
  [54, 8], [54, 9],    // Omelet: Type + Add-ons
  [61, 10],            // Roll Pie: Filling
  [169, 11],           // Turkish Coffee: Size
  [178, 12],           // Espresso: Size
  [180, 13],           // Mikato: Size
  [218, 14],           // Water: Size
  [193, 15],           // Frappuccino: Strength
]
let inserted = 0
for (const [pid, gid] of LINKS) {
  const r = await pg.query(
    `INSERT INTO product_modifier_groups (product_id, modifier_group_id, sort_order)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [pid, gid, gid],
  )
  inserted += r.rowCount ?? 0
}
console.log('neon links inserted:', inserted)

// verify the canonical products on Neon
const p = await pg.query("select id, name, price, active from products where id = any($1::int[]) order by id", [[54, 61, 169, 178, 180, 193, 218]])
for (const r of p.rows) console.log(' ', r.id, r.name, r.price, r.active ? 'ACT' : 'ina')

const off = await pg.query("select count(*)::int c from products where id = any($1::int[]) and active = false", [[55, 56, 57, 58, 59, 60, 170, 179, 181, 194, 219]])
console.log('neon variants deactivated:', off.rows[0].c, '/ 11')

const cats = await pg.query('select count(*)::int c from categories where active = true')
console.log('neon active categories:', cats.rows[0].c, '(expect 17)')

await pg.end()
console.log('DONE')
