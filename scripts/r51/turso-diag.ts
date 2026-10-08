import { createClient } from '@libsql/client'
import { getTursoClient, isTursoConfigured } from '../../src/lib/turso'
import { syncAllToTurso } from '../../src/lib/turso-sync'

async function main() {
  console.log('configured:', isTursoConfigured())
  try {
    const c = getTursoClient()
    const r = await c.execute('SELECT 1 AS ok')
    console.log('ping ok:', JSON.stringify(r.rows))
  } catch (e) {
    console.error('PING FAILED:', e instanceof Error ? e.message : e)
    process.exit(1)
  }
  const report = await syncAllToTurso()
  console.log('report.ok:', report.ok, '| error:', report.error ?? 'none', '| tables:', report.tables?.length, '| totalRows:', report.totalRows, '| durationMs:', report.durationMs)
  const bad = (report.tables || []).filter((t: any) => !t.ok)
  if (bad.length) console.log('failing tables:', JSON.stringify(bad.slice(0, 5)))
  process.exit(report.ok ? 0 : 1)
}
main().catch(e => { console.error('FATAL', e); process.exit(1) })
