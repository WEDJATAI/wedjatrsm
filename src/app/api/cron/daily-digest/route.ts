/**
 * R23: Daily sales digest — Vercel cron endpoint (daily 06:15 UTC, see
 * vercel.json) + manual trigger. Delegates to src/lib/digest.ts (also used
 * by the Inngest rsm-daily-digest function — idempotent by date, safe to
 * run from both schedulers).
 *
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically;
 * manual runs use `?key=$CRON_SECRET`.
 */
import { NextRequest, NextResponse } from 'next/server'
import { isCronAuthorized } from '@/lib/cron'
import { runDailyDigest } from '@/lib/digest'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const date = req.nextUrl.searchParams.get('date') ?? undefined
  try {
    const digest = await runDailyDigest(date)
    return NextResponse.json(digest)
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : 'digest failed' },
      { status: 500 },
    )
  }
}

export async function POST(req: NextRequest) {
  return GET(req)
}
