import { Pool } from 'pg'
import { neonPooledUrl } from './lib/env-local'
import { Database } from 'bun:sqlite'
async function main() {
  const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
  const neon = await pool.query('SELECT id, status FROM orders ORDER BY id')
  await pool.end()
  const db = new Database('/home/z/my-project/db/custom.db', { readonly: true })
  const local: Record<string, string> = {}
  for (const r of db.prepare('SELECT id, status FROM orders').all() as any[]) local[String(r.id)] = r.status
  const neonMap: Record<string, string> = {}
  for (const r of neon.rows as any[]) neonMap[String(r.id)] = r.status
  const diffs: string[] = []
  for (const id of new Set([...Object.keys(local), ...Object.keys(neonMap)])) {
    const l = local[id] ?? 'MISSING'
    const n = neonMap[id] ?? 'MISSING'
    if (l !== n) diffs.push(`#${id}: local=${l} neon=${n}`)
  }
  console.log('STATUS DIFFS (' + diffs.length + '):')
  for (const d of diffs) console.log(' ', d)
}
main().then(() => process.exit(0)).catch(e => { console.error('ERR', e.message); process.exit(1) })
