/**
 * R23: Inngest scheduled functions (cloud background jobs).
 *
 * Every function is idempotent and mirrors a Vercel cron endpoint, so it
 * does not matter which scheduler fires first:
 *
 *   rsm-turso-replica-sync  daily 03:30 UTC  → src/lib/turso-sync.ts
 *   rsm-daily-digest        daily 06:30 UTC  → src/lib/digest.ts
 *   rsm-stale-order-alert   every 30 min     → src/lib/digest.ts
 *     (sub-daily cadence is only available through Inngest — Vercel Hobby
 *      cron is limited to two once-daily jobs)
 */
import { inngest } from './client'
import { syncAllToTurso } from '@/lib/turso-sync'
import { runDailyDigest, runStaleOrderAlert } from '@/lib/digest'

export const functions = [
  inngest.createFunction(
    { id: 'rsm-turso-replica-sync', cron: '30 3 * * *' },
    async () => {
      const report = await syncAllToTurso()
      if (!report.ok) throw new Error(`Turso sync failed: ${report.error ?? 'unknown'}`)
      return { tables: report.tables.length, rows: report.totalRows, durationMs: report.durationMs }
    },
  ),

  inngest.createFunction(
    { id: 'rsm-daily-digest', cron: '30 6 * * *' },
    async () => {
      const digest = await runDailyDigest()
      return { date: digest.date, skipped: digest.skipped ?? false, orders: digest.orderCount, gross: digest.gross }
    },
  ),

  inngest.createFunction(
    { id: 'rsm-stale-order-alert', cron: '*/30 * * * *' },
    async () => {
      return runStaleOrderAlert()
    },
  ),
]
