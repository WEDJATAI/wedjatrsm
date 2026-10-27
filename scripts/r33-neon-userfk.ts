import { Pool } from 'pg'
import { neonPooledUrl } from './lib/env-local'
async function main() {
  const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
  // all FKs referencing users
  const fk = await pool.query(`SELECT conrelid::regclass AS tbl, conname, pg_get_constraintdef(oid) def FROM pg_constraint WHERE confrelid = 'users'::regclass AND contype = 'f'`)
  console.log('FKs referencing users:')
  for (const r of fk.rows) console.log('  ', r.tbl, '→', r.def)
  // rows referencing user 14 in each referencing table
  for (const r of fk.rows) {
    const tbl = String(r.tbl)
    const m = /REFERENCES users\(id\)/.exec(String(r.def))
    const colMatch = /\(([^)]+)\)/.exec(String(r.def))
    if (!m || !colMatch) continue
    const col = colMatch[1]
    try {
      const c = await pool.query(`SELECT COUNT(*)::int c FROM ${tbl} WHERE ${col} = 14`)
      if (c.rows[0].c > 0) console.log(`  !! ${tbl}.${col} = 14 → ${c.rows[0].c} rows`)
    } catch (e: unknown) { console.log('  (skip', tbl, (e instanceof Error ? e.message : String(e)).slice(0, 40), ')') }
  }
  const pr = await pool.query(`SELECT id, name_ar, name_en, price, active FROM products WHERE id IN (226,227,228,229)`)
  console.log('Neon-only products:')
  for (const r of pr.rows) console.log('  ', r.id, r.name_en, '| AR:', r.name_ar, '| EGP', r.price, '| active:', r.active)
  await pool.end()
}
main().then(() => process.exit(0)).catch(e => { console.error('ERR', e.message); process.exit(1) })
