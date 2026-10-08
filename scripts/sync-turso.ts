/**
 * R23: Manual Turso replica sync — same engine as the scheduled jobs
 * (/api/cron/turso-sync + Inngest rsm-turso-replica-sync).
 *
 *   TURSO_DATABASE_URL=libsql://… TURSO_AUTH_TOKEN=… bun scripts/sync-turso.ts
 */
import { syncAllToTurso } from '../src/lib/turso-sync'

const report = await syncAllToTurso()
console.log(JSON.stringify(report, null, 2))
if (!report.ok) {
  console.error('[sync-turso] FAILED:', report.error)
  process.exit(1)
}
