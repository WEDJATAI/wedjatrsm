// r35: verify the agent-synced rows reached the Turso replica, then refresh.
import { syncAllToTurso } from '../../src/lib/turso-sync'
import { getTursoClient } from '../../src/lib/turso'

async function main() {
  const report = await syncAllToTurso()
  console.log('turso refresh:', JSON.stringify({ tables: report.tables.length, rows: report.tables.reduce((a: number, t: any) => a + t.rows, 0), ms: (report as { ms?: number }).ms ?? (report as { durationMs?: number }).durationMs }, null, 0))
  const turso = getTursoClient()
  const r = await turso.execute("SELECT id, name FROM customers WHERE id = 15")
  console.log('TURSO customer 15:', JSON.stringify(r.rows))
}
main().then(() => process.exit(0)).catch(e => { console.error('FAIL', e.message); process.exit(1) })
