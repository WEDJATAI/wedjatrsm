import { syncAllToTurso } from '../../src/lib/turso-sync'
import { getTursoClient } from '../../src/lib/turso'
const report = await syncAllToTurso()
console.log('TURSO SYNC:', JSON.stringify({ ok: report.ok, tables: report.tables.length, totalRows: report.totalRows, durationMs: report.durationMs, error: report.error }))
const bad = report.tables.filter((t) => !t.ok)
console.log(bad.length === 0 ? 'ALL TABLES OK' : 'MISMATCHES: ' + JSON.stringify(bad))
const turso = getTursoClient()
for (const q of [
  "SELECT count(*) n FROM customers",
  "SELECT count(*) n FROM orders",
  "SELECT count(*) n FROM payments",
  "SELECT count(*) n FROM inventory_transactions",
  "SELECT count(*) n FROM audit_logs",
]) {
  const r = await turso.execute(q)
  console.log('TURSO', q.replace('SELECT count(*) n FROM ', ''), '=', JSON.stringify(r.rows[0]))
}
