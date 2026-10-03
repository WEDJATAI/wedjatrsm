/** p20: on-demand Turso replica refresh from the local terminal (source == Neon after parity convergence — verified 1038/1038 orders, 208/208 payments). Idempotent full refresh, safe to re-run. */
import { syncAllToTurso } from '../src/lib/turso-sync'
const report = await syncAllToTurso()
console.log('ok:', report.ok, '| tables:', report.tables?.length, '| totalRows:', report.totalRows, '| durationMs:', report.durationMs)
const bad = (report.tables || []).filter((t: any) => !t.ok)
console.log('tables not ok:', bad.length ? JSON.stringify(bad) : 'none — all exact')
process.exit(report.ok ? 0 : 1)
