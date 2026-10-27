import { writeFileSync } from 'node:fs'
import { tursoAuthToken, tursoPipelineUrl } from './lib/env-local'
const tok = tursoAuthToken()
const TURL = tursoPipelineUrl()
const hdr = { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }

async function tursoQuery(sql: string) {
  const body = JSON.stringify({ requests: [{ type: 'execute', stmt: { sql: sql } }, { type: 'close' }] })
  const res = await fetch(TURL, { method: 'POST', headers: hdr, body: body })
  const j = await res.json()
  const r = j.results[0].response.result
  return { cols: r.cols.map(function (c: any) { return c.name }), rows: r.rows }
}

const tList = await tursoQuery("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
const tursoTables = tList.rows.map(function (row: any[]) { return row[0].value })
const tursoDump: Record<string, any[]> = {}
for (const t of tursoTables) {
  const q = await tursoQuery('SELECT * FROM "' + t + '"')
  tursoDump[t] = q.rows.map(function (row: any[]) {
    const obj: Record<string, any> = {}
    q.cols.forEach(function (c: string, i: number) {
      const cell = row[i]
      obj[c] = cell === null || cell === undefined || cell.type === 'null' ? null : cell.value
    })
    return obj
  })
}
const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
const tursoPath = '/home/z/my-project/backups/pre-p10-turso-' + ts + '.json'
writeFileSync(tursoPath, JSON.stringify({ dumpedAt: new Date().toISOString(), tables: tursoDump }))
let tursoRows = 0
for (const k of Object.keys(tursoDump)) { tursoRows += tursoDump[k].length }
console.log('TURSO backup: ' + tursoPath + ' (' + tursoTables.length + ' tables, ' + tursoRows + ' rows)')
