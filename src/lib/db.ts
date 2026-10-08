/**
 * R49 (Prisma 7): the client requires a DRIVER ADAPTER — the Rust query
 * engine is gone (the WASM query compiler rides inside @prisma/client).
 *
 *   • SQLite (local terminals + Windows desktop): @prisma/adapter-libsql —
 *     chosen over better-sqlite3 because Bun does not support
 *     better-sqlite3 AT ALL (oven-sh/bun#4290) while @libsql/client is
 *     proven in this codebase (the Turso replicator has used it since r23).
 *   • PostgreSQL (Vercel/Neon cloud): @prisma/adapter-pg over the `pg`
 *     driver (already a dependency for the Neon ops scripts).
 *
 * r31 write-safety continuity: the old engine mapped the
 * ?socket_timeout=30000 URL param onto sqlite3_busy_timeout. The libsql
 * driver does NOT parse that param (it would treat it as part of the file
 * name!), so the URL is stripped here and the busy timeout is applied as a
 * PRAGMA in ensureSqlitePragmas() — same 30 s polite contention wait, same
 * single-connection discipline (one PrismaClient per process ⇒ one libsql
 * connection; the pragma is set once per process and sticks).
 */
import { PrismaLibSql } from '@prisma/adapter-libsql'
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient } from '@prisma/client'

// r49: runtime guard — @/lib/db pulls Node-only driver adapters (pg/libsql
// → node:fs/dns) and must never execute in a browser. The audit-actions
// split keeps it out of the client graph (the pg/dns bundling error catches
// future slips at build time); this check catches a runtime slip. The
// `server-only` package can't be used here — raw Bun/Node scripts import
// this module too, and it throws unconditionally outside a bundler graph.
if (typeof window !== 'undefined') {
  throw new Error('[@/lib/db] imported in a browser context — server-only module (r49)')
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  /** r31: sqlite pragma bootstrap — one attempt per process (see below) */
  rsmSqlitePragmas?: Promise<void>
}

/** r37 heritage: heal a param-less DATABASE_URL by appending the r31
 *  write-safety params (kept for any code path that still inspects the env
 *  var — backup/db-snapshot resolve the file path and tolerate params;
 *  the ADAPTER below strips them again before connecting). */
const rsmRawUrl = process.env.DATABASE_URL ?? ''
if (rsmRawUrl.startsWith('file:') && !rsmRawUrl.includes('socket_timeout=')) {
  process.env.DATABASE_URL =
    rsmRawUrl + (rsmRawUrl.includes('?') ? '&' : '?') + 'socket_timeout=30000&connection_limit=1'
  console.warn(
    '[db] DATABASE_URL missing r31 write-safety params — self-healed: appended socket_timeout=30000&connection_limit=1 (worklog r31/r37)',
  )
}

/** r49: clean file URL for the libsql adapter — strips the r31 engine-era
 *  query params (libsql would otherwise resolve a LITERALLY-named file like
 *  "custom.db?socket_timeout=30000" — an empty new database!). */
function adapterFileUrl(url: string): string {
  const q = url.indexOf('?')
  return q === -1 ? url : url.slice(0, q)
}

const isSqlite = (process.env.DATABASE_URL ?? '').startsWith('file:')

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    // R23: query logging is invaluable locally but noisy + slow on the
    // serverless cloud deployment. Opt-in via RSM_QUERY_LOG=1 for a
    // debugging session (r31 audit: 70k lines / 23 MB per 3-min run).
    log:
      process.env.NODE_ENV === 'production'
        ? ['error']
        : process.env.RSM_QUERY_LOG === '1'
          ? ['query', 'error', 'warn']
          : ['error', 'warn'],
    // r49: Prisma 7 driver adapters — see the header comment.
    adapter: isSqlite
      ? new PrismaLibSql({ url: adapterFileUrl(process.env.DATABASE_URL ?? 'file:./db/custom.db') })
      : new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

// ─── r31 audit fix: WAL journal mode + busy timeout ─────────────────
// The r31 stress test proved the write path collapses under a realistic
// order rush with SQLite's default `journal_mode=delete`. WAL fixes the
// convoy (readers never block the writer) and is PERSISTENT in the db file
// header, so one successful run covers every later connection (scripts,
// short-lived clients, restored snapshots on next boot).
//
// r49 NOTE: under the libsql driver the busy timeout is OURS to set — the
// old "do not PRAGMA busy_timeout" warning applied to the Rust engine,
// which silently overrode the pragma with the ?socket_timeout= URL param.
// The adapter strips that param, so the PRAGMA below is now the single
// source of truth for the 30 s contention wait (the r31-proven value).
// Gated to file: datasources — the cloud (Neon Postgres) must not see
// SQLite pragmas. Failures are logged and never fatal.
export function ensureSqlitePragmas(): Promise<void> {
  if (!globalForPrisma.rsmSqlitePragmas) {
    globalForPrisma.rsmSqlitePragmas = (async () => {
      if (!isSqlite) return // cloud postgres — not ours to tune
      try {
        // NOTE: PRAGMA statements return their (new) value as a result row,
        // so they must run through $queryRawUnsafe — $executeRawUnsafe
        // rejects row-returning statements.
        await db.$queryRawUnsafe('PRAGMA journal_mode=WAL')
        // WAL-safe + fast: recommended setting for WAL databases.
        await db.$queryRawUnsafe('PRAGMA synchronous=NORMAL')
        // r31 value, now owned here (see the r49 note above).
        await db.$queryRawUnsafe('PRAGMA busy_timeout=30000')
        console.log('[db] sqlite pragmas applied: journal_mode=WAL, synchronous=NORMAL, busy_timeout=30000 (libsql adapter)')
      } catch (err) {
        console.warn('[db] sqlite pragma bootstrap failed (non-fatal):', err)
      }
    })()
  }
  return globalForPrisma.rsmSqlitePragmas
}

void ensureSqlitePragmas()
