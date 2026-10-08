/**
 * R23: Turso replica sync — Vercel cron endpoint (daily 03:00 UTC, see
 * vercel.json) + manual trigger. Delegates to src/lib/turso-sync.ts (also
 * used by the Inngest rsm-turso-replica-sync function — idempotent, safe
 * to run from both schedulers).
 *
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically;
 * manual runs use `?key=$CRON_SECRET`.
 */
import { NextRequest, NextResponse } from 'next/server'
import { isCronAuthorized } from '@/lib/cron'
import { syncAllToTurso } from '@/lib/turso-sync'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const report = await syncAllToTurso()
  // 200 on success, 502 with details on configuration/token problems —
  // Vercel cron logs the body, so failures are diagnosable from the log.
  return NextResponse.json(report, { status: report.ok ? 200 : 502 })
}

export async function POST(req: NextRequest) {
  return GET(req)
}
