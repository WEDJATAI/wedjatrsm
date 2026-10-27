/**
 * R23: Turso (libsql) client.
 *
 * R73 CUTOVER: Turso is now the CLOUD PRIMARY datastore (Vercel production
 * DATABASE_URL = libsql://…) after Neon PostgreSQL's free-tier compute quota
 * hard-blocked the account on Oct 27 2026. On the LOCAL/desktop planes this
 * same client still drives the analytics/backup REPLICA refresh
 * (src/lib/turso-sync.ts — full idempotent copy local → Turso) from:
 *   - the daily Vercel cron        (/api/cron/turso-sync — no-ops on the cloud since r73)
 *   - the daily Inngest function   (rsm-turso-replica-sync — no-ops on the cloud since r73)
 *   - on demand                    (curl the cron endpoint with CRON_SECRET)
 *
 * Config comes from the Turso Vercel integration's env vars:
 *   TURSO_DATABASE_URL (libsql://…) + TURSO_AUTH_TOKEN.
 */
import { createClient, type Client } from '@libsql/client'

let cached: Client | null = null

export function isTursoConfigured(): boolean {
  return Boolean(process.env.TURSO_DATABASE_URL && process.env.TURSO_AUTH_TOKEN)
}

/** Lazily-created singleton Turso client (throws if not configured). */
export function getTursoClient(): Client {
  if (cached) return cached
  const url = process.env.TURSO_DATABASE_URL
  const authToken = process.env.TURSO_AUTH_TOKEN
  if (!url || !authToken) {
    throw new Error('Turso replica is not configured (TURSO_DATABASE_URL / TURSO_AUTH_TOKEN missing)')
  }
  cached = createClient({ url, authToken })
  return cached
}
