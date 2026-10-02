import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  /** r31: sqlite pragma bootstrap — one attempt per process (see below) */
  rsmSqlitePragmas?: Promise<void>
}

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    // R23: query logging is invaluable locally but noisy + slow on the
    // serverless cloud deployment (every query becomes a log line). Keep it
    // for dev, keep only errors for production (Vercel + packaged desktop).
    // r31 audit update: the stress test measured the dev query log at
    // 70k lines / 23 MB per 3-minute run with visible latency and memory
    // cost (next-server ballooned to 2.5 GB RSS → OOM-killed on the 4 GB
    // sandbox). Query logging is now OPT-IN: set RSM_QUERY_LOG=1 to get
    // the old behavior back for a debugging session.
    log:
      process.env.NODE_ENV === 'production'
        ? ['error']
        : process.env.RSM_QUERY_LOG === '1'
          ? ['query', 'error', 'warn']
          : ['error', 'warn'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

// ─── r31 audit fix: WAL journal mode + busy timeout ─────────────────
// The r31 stress test proved the write path collapses under a realistic
// order rush (6 concurrent waiters → 93% create failures) with SQLite's
// default `journal_mode=delete`: every commit takes an exclusive lock,
// readers starve writers and each other, and Prisma's 5 s interactive
// transaction timeout aborts with P2024/P1008 → raw 500s to the POS.
//
// WAL fixes the convoy (readers never block the writer; the writer never
// blocks readers) and `journal_mode=WAL` is PERSISTENT in the db file
// header, so one successful run covers every later connection (scripts,
// short-lived clients, restored snapshots on next boot). busy_timeout
// makes competing writers wait politely instead of failing instantly.
//
// Gated to file: datasources — the cloud (Neon Postgres) must not see
// SQLite pragmas. Fire-and-forget at module init: Prisma serializes
// SQLite queries through its engine, so the pragmas are queued before
// any racing first query from this same client. Failures are logged and
// never fatal (a read-only fs or exotic driver must not take the app down).
export function ensureSqlitePragmas(): Promise<void> {
  if (!globalForPrisma.rsmSqlitePragmas) {
    globalForPrisma.rsmSqlitePragmas = (async () => {
      const url = process.env.DATABASE_URL ?? ''
      if (!url.startsWith('file:')) return // cloud postgres — not ours to tune
      try {
        // NOTE: PRAGMA statements return their (new) value as a result row,
        // so they must run through $queryRawUnsafe — $executeRawUnsafe
        // rejects row-returning statements in Prisma's SQLite driver.
        await db.$queryRawUnsafe('PRAGMA journal_mode=WAL')
        // WAL-safe + fast: recommended setting for WAL databases.
        await db.$queryRawUnsafe('PRAGMA synchronous=NORMAL')
        // r31 NOTE: do NOT set busy_timeout here. Prisma's SQLite driver
        // maps the ?socket_timeout= URL param (ms) onto sqlite3_busy_timeout
        // — a PRAGMA after connect would OVERRIDE it and cap contention
        // waits at the pragma value (a 10 s pragma silently defeated the
        // 30 s URL setting and re-created the write-contention 500s).
        console.log('[db] sqlite pragmas applied: journal_mode=WAL, synchronous=NORMAL (busy timeout governed by ?socket_timeout= URL param)')
      } catch (err) {
        console.warn('[db] sqlite pragma bootstrap failed (non-fatal):', err)
      }
    })()
  }
  return globalForPrisma.rsmSqlitePragmas
}

void ensureSqlitePragmas()
