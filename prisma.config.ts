/**
 * R49: Prisma 7 configuration — the connection URL no longer lives in the
 * schema files (v7 breaking change). CLI commands (db push / migrate) read
 * the datasource from here; the app runtime passes a driver adapter to
 * PrismaClient instead (src/lib/db.ts).
 *
 * Resolution order for the URL:
 *   1. process.env.DATABASE_URL — set by the environment (Vercel sets the
 *      Neon Postgres URL for deploy-time commands; local shells inherit
 *      the sqlite file URL).
 *   2. .env fallback parse — when the CLI runs under plain `node` (no
 *      Bun auto-env), load the file manually. Bun (`bun run db:push`)
 *      auto-loads .env, so this is a defensive path only.
 *
 * The SCHEMA is irrelevant to this config for `generate` (which is passed
 * --schema explicitly by the Vercel buildCommand and local scripts); it is
 * declared for CLI commands that default to the local SQLite schema.
 */
import { defineConfig } from 'prisma/config'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function resolveUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL
  try {
    const raw = readFileSync(resolve(process.cwd(), '.env'), 'utf8')
    const m = raw.match(/^DATABASE_URL=(.*)$/m)
    if (m) return m[1].trim().replace(/^["']|["']$/g, '')
  } catch {
    /* no .env — fall through */
  }
  return 'file:./db/custom.db'
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: resolveUrl(),
  },
})
