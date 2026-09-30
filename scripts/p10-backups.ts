import { Database } from 'bun:sqlite'
import { Pool } from 'pg'
import { writeFileSync, statSync, readFileSync } from 'node:fs'

const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
const dir = '/home/z/my-project/backups'

// 1) LOCAL: WAL-safe VACUUM INTO snapshot
const local = new Database('/home/z/my-project/db/custom.db', { readonly: true })
const localPath = dir + '/pre-p10-local-' + ts + '.db'
local.exec("VACUUM INTO '" + localPath + "'")
console.log('LOCAL backup: ' + localPath + ' (' + (statSync(localPath).size / 1024).toFixed(1) + ' KB)')

// 2) NEON: full JSON dump of all public tables
const neon = new Pool({ connectionString: 'postgresql://neondb_owner:npg_8r0cMUtoipnQ@ep-flat-bonus-au9hoj3b-pooler.c-10.us-east-1.aws.neon.tech/neondb?channel_binding=require&sslmode=require', ssl: { rejectUnauthorized: false } })
const tr = await neon.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name")
const neonTables: string[] = tr.rows.map((r: any) => r.table_name)
const neonDump: Record<string, any[]> = {}
for (const t of neonTables) {
  const q = await neon.query('SELECT * FROM "' + t + '"')
  neonDump[t] = q.rows
}
const neonPath = dir + '/pre-p10-neon-' + ts + '.json'
writeFileSync(neonPath, JSON.stringify({ dumpedAt: new Date().toISOString(), tables: neonDump }))
const neonRows = Object.values(neonDump).reduce((a: number, b: any[]) => a + b.length, 0)
console.log('NEON backup: ' + neonPath + ' (' + neonTables.length + ' tables, ' + neonRows + ' rows)')
await neon.end()

// 3) TURSO: full JSON dump via Hrana pipeline
const tok = readFileSync('/home/z/my-project/.env.deploy-local', 'utf8').match(/^TURSO_AUTH_TOKEN=(.+)$/m)![1].trim()
const TURL = 'https://wedjatrsm-vercel-icfg-fk7nzkekcm9ddsa6farl6t5h.aws-us-east-1.turso.io/v2/pipeline'
const hdr = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }
async function tursoQuery(sql: string): Promise<{ cols: string[]; rows: any[][] }> {
  const body = JSON.stringify({ requests: [{ type: 'execute', stmt: { sql } }, { type: 'close' }] })
  const res = await fetch(TURL, { method: 'POST', headers: hdr, body })
  const j: any = await res.json()
  const r = j.results[0].response
  return { cols: r.cols.map((c: any) => c.name), rows: r.rows }
}
const tList = await tursoQuery("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
const tursoTables = tList.rows.map((row: any[]) => row[0].value)
const tursoDump: Record<string, any[]> = {}
for (const t of tursoTables) {
  const q = await tursoQuery('SELECT * FROM "' + t + '"')
  tursoDump[t] = q.rows.map((row: any[]) => {
    const obj: Record<string, any> = {}
    q.cols.forEach((c, i) => { obj[c] = row[i] && row[i].type === 'null' ? null : row[i] ? row[i].value : null })
    return obj
  })
}
const tursoPath = dir + '/pre-p10-turso-' + ts + '.json'
writeFileSync(tursoPath, JSON.stringify({ dumpedAt: new Date().toISOString(), tables: tursoDump }))
const tursoRows = Object.values(tursoDump).reduce((a: number, b: any[]) => a + b.length, 0)
console.log('TURSO backup: ' + tursoPath + ' (' + tursoTables.length + ' tables, ' + tursoRows + ' rows)')
console.log('ALL BACKUPS DONE @ ' + ts)
