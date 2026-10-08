import { syncAllToTurso } from '../../src/lib/turso-sync'
import { getTursoClient } from '../../src/lib/turso'
async function main() {
  await syncAllToTurso()
  const turso = getTursoClient()
  const r = await turso.execute("SELECT count(*) n FROM customers WHERE id=15")
  console.log('TURSO test-customer remaining (0 expected):', JSON.stringify(r.rows))
  const all = await turso.execute("SELECT id, name FROM customers ORDER BY id")
  console.log('TURSO customers (all):', JSON.stringify(all.rows))
}
main().then(() => process.exit(0)).catch(e => { console.error('FAIL', e.message); process.exit(1) })
