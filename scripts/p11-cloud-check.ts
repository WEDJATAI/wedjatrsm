// p11 cloud harmony check: proves Neon (Postgres) + Turso (libsql replica) are
// both reachable with the credentials in gitignored .env.deploy-local, and that
// their row counts agree (the P5 invariant). Read-only. Also verifies the Lelo
// menu landed on the cloud (item 6 evidence) and reports hybrid_devices.
import { Pool } from 'pg'
import { neonPooledUrl, tursoAuthToken, tursoPipelineUrl } from './lib/env-local'

const KEY_TABLES = ['categories', 'products', 'orders', 'order_items', 'payments', 'users', 'hybrid_devices', 'hybrid_events']

// ---------- Neon ----------
const neon = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false } })
const neonTables: string[] = (await neon.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name")).rows.map((r: any) => r.table_name)
console.log('NEON: connected. public tables =', neonTables.length)

const neonCounts: Record<string, number> = {}
for (const t of KEY_TABLES) {
  if (!neonTables.includes(t)) { neonCounts[t] = -1; continue }
  neonCounts[t] = Number((await neon.query('SELECT COUNT(*)::int AS c FROM "' + t + '"')).rows[0].c)
}
console.log('NEON counts:', JSON.stringify(neonCounts))

const leloNeon = await neon.query("SELECT COUNT(*)::int AS c FROM products WHERE id >= 50").then(r => Number(r.rows[0].c))
const catNeon = await neon.query('SELECT COUNT(*)::int AS c FROM categories').then(r => Number(r.rows[0].c))
console.log('NEON Lelo products (id>=50):', leloNeon, '| categories total:', catNeon)
const devices = await neon.query('SELECT "deviceId", name FROM hybrid_devices ORDER BY name')
console.log('NEON devices:', JSON.stringify(devices.rows))
await neon.end()

// ---------- Turso ----------
const hdr = { Authorization: 'Bearer ' + tursoAuthToken(), 'Content-Type': 'application/json' }
const TURL = tursoPipelineUrl()
async function tursoQuery(sql: string) {
  const body = JSON.stringify({ requests: [{ type: 'execute', stmt: { sql } }, { type: 'close' }] })
  const res = await fetch(TURL, { method: 'POST', headers: hdr, body })
  if (!res.ok) throw new Error('Turso HTTP ' + res.status)
  const j = await res.json() as any
  if (j.results?.[0]?.type === 'error') throw new Error('Turso: ' + JSON.stringify(j.results[0].error).slice(0, 200))
  const r = j.results[0].response.result
  return { cols: r.cols.map((c: any) => c.name), rows: r.rows }
}
const tList = await tursoQuery("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
const tursoTables = tList.rows.map((row: any[]) => row[0].value)
console.log('TURSO: connected. tables =', tursoTables.length)

const tursoCounts: Record<string, number> = {}
for (const t of KEY_TABLES) {
  if (!tursoTables.includes(t)) { tursoCounts[t] = -1; continue }
  const q = await tursoQuery('SELECT COUNT(*) AS c FROM "' + t + '"')
  tursoCounts[t] = Number(q.rows[0][0].value)
}
console.log('TURSO counts:', JSON.stringify(tursoCounts))

// ---------- Agreement ----------
let agree = true
for (const t of KEY_TABLES) {
  if (neonCounts[t] !== tursoCounts[t]) { agree = false; console.log('MISMATCH', t, 'neon=', neonCounts[t], 'turso=', tursoCounts[t]) }
}
console.log(agree ? 'AGREEMENT: Neon and Turso row counts match on all key tables.' : 'AGREEMENT: FAILED — see mismatches above')
