/**
 * R23: Shared cron-endpoint authorization.
 *
 * Vercel Cron automatically sends `Authorization: Bearer $CRON_SECRET` when
 * the CRON_SECRET env var is set on the project. The same endpoints can be
 * triggered manually with `?key=$CRON_SECRET`. When no secret is configured
 * (local dev) the endpoints are open — they are read-only/replication jobs.
 */
import type { NextRequest } from 'next/server'

export function isCronAuthorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return true
  if (req.headers.get('authorization') === `Bearer ${secret}`) return true
  if (req.nextUrl.searchParams.get('key') === secret) return true
  return false
}
