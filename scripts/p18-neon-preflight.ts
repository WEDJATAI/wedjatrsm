/** p18 preflight — verify Neon id state for the products/categories we touch. */
import { Client } from 'pg'
import { readFileSync } from 'node:fs'

const url = readFileSync('/home/z/my-project/.env.deploy-local', 'utf8').match(/^NEON_DATABASE_URL=(.+)$/m)![1].trim()
const client = new Client({ connectionString: url })
await client.connect()

const ids = [50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 226, 227, 228, 229, 169, 170, 178, 179, 180, 181, 193, 194, 218, 219]
const p = await client.query('select id, name, category_id, active from products where id = any($1::int[]) order by id', [ids])
console.log('=== NEON products ===')
for (const r of p.rows) console.log(String(r.id).padStart(4), String(r.name).padEnd(30), 'cat', String(r.category_id).padEnd(4), r.active ? 'ACT' : 'ina')

const cids = [5, 7, 8, 9, 10, 11, 12, 16, 18, 19, 25, 28, 29]
const c = await client.query('select id, name, active, display_order from categories where id = any($1::int[]) order by id', [cids])
console.log('=== NEON categories ===')
for (const r of c.rows) console.log(String(r.id).padStart(4), String(r.name).padEnd(26), r.active ? 'ACT ' : 'ina ', 'ord', r.display_order)

await client.end()
