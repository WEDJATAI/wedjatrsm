/**
 * R23: Turso (libsql) replica client.
 *
 * The Turso database is the analytics / backup REPLICA of the system of
 * record (SQLite locally + on the Windows desktop app; Neon PostgreSQL on
 * the Vercel production deployment). It is kept in sync by
 * src/lib/turso-sync.ts (full, idempotent refresh) which runs from:
 *   - the daily Vercel cron        (/api/cron/turso-sync)
 *   - the daily Inngest function   (rsm-turso-replica-sync)
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
