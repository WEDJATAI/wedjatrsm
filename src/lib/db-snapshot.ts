/**
 * R21: In-app database snapshot engine — the resilience answer to the R18/R20
 * environment resets (sandbox wiped db/ and backups/ twice on 2026-09-17;
 * download/ survived both times).
 *
 * Takes a consistency-guaranteed VACUUM INTO snapshot of the live database and:
 *   1. stores it in backups/auto/custom-<stamp>.db (rotated, keep last N),
 *   2. atomically refreshes download/rsm-platform-database.db (THE recovery point),
 *   3. refreshes download/rsm-database-manifest.json (table counts + invariants).
 *
 * Runtime-portable by design: pure Prisma + node:fs (no bun:sqlite), so the exact
 * same module runs inside the Next.js server (node runtime), from bun CLI scripts,
 * and inside the offline Windows package.
 *
 * Driven by src/instrumentation.ts (server-boot hook, every 10 min on change) and
 * wrapped by scripts/snapshot.ts (manual CLI) + scripts/snapshot-watcher.ts
 * (standalone loop for deployment environments where background shells survive).
 */
import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const AUTO_DIR = join(ROOT, 'backups/auto');
const RECOVERY_POINT = join(ROOT, 'download/rsm-platform-database.db');
const RECOVERY_TMP = join(ROOT, 'download/.rsm-platform-database.db.tmp');
const MANIFEST_PATH = join(ROOT, 'download/rsm-database-manifest.json');
const STATE_PATH = join(AUTO_DIR, 'watcher-state.json');
const LOG_PATH = join(AUTO_DIR, 'watcher.log');
const KEEP_SNAPSHOTS = 30;
const LOG_MAX_BYTES = 256 * 1024;

export interface SnapshotResult {
  ok: boolean;
  path: string;
  bytes: number;
  reason: string;
  integrity: string;
  tableCount: number;
  totalRows: number;
  takenAt: string;
}

interface WatcherState {
  pid?: number;
  lastDbMtimeMs?: number;
  lastSnapshotAt?: string;
  snapshotCount?: number;
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

function log(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try {
    mkdirSync(AUTO_DIR, { recursive: true });
    if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > LOG_MAX_BYTES) {
      writeFileSync(LOG_PATH, line);
    } else {
      appendFileSync(LOG_PATH, line);
    }
  } catch {
    /* logging must never break snapshotting */
  }
}

/** Resolve the SQLite file path from DATABASE_URL (file:…), relative to cwd if needed. */
function dbFilePath(): string | null {
  const url = process.env.DATABASE_URL ?? '';
  const m = /file:(.+)/.exec(url);
  if (!m) return null;
  const raw = m[1].split('?')[0];
  if (raw.startsWith('/')) return raw;
  return join(ROOT, raw);
}

function readState(): WatcherState {
  try {
    if (existsSync(STATE_PATH)) return JSON.parse(readFileSync(STATE_PATH, 'utf8')) as WatcherState;
  } catch {
    /* fallthrough */
  }
  return {};
}

function writeState(state: WatcherState): void {
  try {
    mkdirSync(AUTO_DIR, { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
  } catch {
    /* best effort */
  }
}

function refreshRecoveryPoint(snapshotPath: string): void {
  copyFileSync(snapshotPath, RECOVERY_TMP);
  if (existsSync(RECOVERY_POINT)) unlinkSync(RECOVERY_POINT);
  renameSync(RECOVERY_TMP, RECOVERY_POINT);
}

// ─── p19 recycle guard ─────────────────────────────────────────────────
// The sandbox recycle (8 events so far) wipes db/custom.db to a BARE
// schema: integrity ok, foreign keys ok, 0 users. Without these guards the
// watcher snapshotted the bare db within minutes and refreshRecoveryPoint()
// DESTROYED the tracked recovery point (recorded in the recycle-7 worklog:
// "lazy-init at 03:38 overwrote the download recovery point too"). Rules:
//   guard 1 — a live db with 0 users (or no users table) may never be
//             snapshotted while a recovery point/manifest exists;
//   guard 2 — a snapshot losing >60% of the manifest's rows may never
//             replace the recovery point (partial-wipe signature).
// Escape hatch for an INTENTIONAL shrink (e.g. retiring a demo dataset):
// RSM_SNAPSHOT_ALLOW_SHRINK=1. After a recycle run:
//   bun scripts/auto-heal.ts   (or simply reboot — src/lib/recycle-guard.ts
//                               self-heals at boot).

/** Count users on a db; null when the users table does not exist yet. (exported for scripts/tests) */
export async function liveUserCount(
  p: { $queryRawUnsafe: PrismaClient['$queryRawUnsafe'] },
): Promise<number | null> {
  const t = await p.$queryRawUnsafe(
    `SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='users'`,
  ) as Array<{ c: number | bigint }>;
  if (Number(t[0]?.c ?? 0) === 0) return null;
  const u = await p.$queryRawUnsafe(`SELECT COUNT(*) AS c FROM users`) as Array<{ c: number | bigint }>;
  return Number(u[0]?.c ?? 0);
}

/** Guard 1: refuse to snapshot a bare/recycled live db over an existing recovery point. (exported for scripts/tests) */
export async function assertNotBareDb(db: PrismaClient): Promise<void> {
  if (!existsSync(RECOVERY_POINT) && !existsSync(MANIFEST_PATH)) return; // nothing to protect yet
  const users = await liveUserCount(db);
  if (users === null) {
    throw new Error(
      'recycle-guard: live db has no users table (pre-schema) — refusing to snapshot over the existing recovery point. ' +
        'Run `bun scripts/auto-heal.ts` or reboot (boot self-heal) to restore.',
    );
  }
  if (users === 0) {
    throw new Error(
      'recycle-guard: live db has 0 users (bare-db recycle signature) — refusing to snapshot/overwrite the recovery point. ' +
        'Run `bun scripts/auto-heal.ts` or reboot (boot self-heal) to restore.',
    );
  }
}

/** Guard 2: refuse to demote the recovery point when rows collapse (>60% drop). (exported for scripts/tests) */
export function assertNoShrink(totalRows: number): void {
  if (process.env.RSM_SNAPSHOT_ALLOW_SHRINK === '1') return;
  if (!existsSync(MANIFEST_PATH)) return;
  let prevRows = 0;
  try {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as { totalRows?: number };
    prevRows = typeof manifest.totalRows === 'number' ? manifest.totalRows : 0;
  } catch {
    return; // unreadable manifest → nothing to compare against
  }
  if (prevRows > 1000 && totalRows < prevRows * 0.4) {
    throw new Error(
      `recycle-guard: snapshot has ${totalRows} rows vs manifest ${prevRows} (>60% drop — partial-wipe signature). ` +
        'Recovery point NOT demoted. If this shrink is intentional: RSM_SNAPSHOT_ALLOW_SHRINK=1.',
    );
  }
}

function updateManifest(counts: Array<{ table: string; rows: number }>, reason: string, bytes: number): void {
  let manifest: Record<string, unknown> = {};
  if (existsSync(MANIFEST_PATH)) {
    try {
      manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Record<string, unknown>;
    } catch {
      manifest = {};
    }
  }
  const byTable: Record<string, number> = {};
  for (const { table, rows } of counts) byTable[table] = rows;
  manifest.generatedAt = new Date().toISOString();
  manifest.reason = reason;
  manifest.bytes = bytes;
  manifest.tableCount = counts.length;
  manifest.totalRows = counts.reduce((s, c) => s + c.rows, 0);
  manifest.tables = byTable;
  manifest.invariants = {
    ...(typeof manifest.invariants === 'object' && manifest.invariants !== null ? (manifest.invariants as Record<string, unknown>) : {}),
    integrityChecked: true,
    recoveryPoint: 'download/rsm-platform-database.db (auto-refreshed by src/lib/db-snapshot.ts)',
  };
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
}

function rotate(): void {
  if (!existsSync(AUTO_DIR)) return;
  const snaps = readdirSync(AUTO_DIR)
    .filter((f) => /^custom-\d{8}-\d{6}\.db$/.test(f))
    .sort()
    .reverse();
  for (const old of snaps.slice(KEEP_SNAPSHOTS)) {
    try {
      unlinkSync(join(AUTO_DIR, old));
    } catch {
      /* best effort */
    }
  }
}

/**
 * Take one snapshot. Short-lived Prisma client per call — always binds to the
 * currently generated client, so client regeneration (prisma db push) can never
 * strand a long-lived stale client (the R19 incident).
 * Throws on any integrity failure: a corrupt snapshot must never replace a good
 * recovery point.
 */
export async function takeSnapshot(reason = 'manual'): Promise<SnapshotResult> {
  // R23: SQLite-only engine — on the cloud deployment (Neon Postgres) there
  // is no file to VACUUM INTO; backups there are Neon PITR + Turso replica.
  if (!process.env.DATABASE_URL?.startsWith('file:')) {
    throw new Error('Snapshots are only supported on SQLite deployments (local / Windows app)');
  }
  const db = new PrismaClient({ adapter: new PrismaLibSql({ url: (process.env.DATABASE_URL ?? 'file:./db/custom.db').split('?')[0] }) }) // r49: Prisma 7 adapter;
  try {
    const integrityRows = await db.$queryRawUnsafe(`PRAGMA integrity_check`) as Array<{ integrity_check: string }>;
    const integrity = integrityRows[0]?.integrity_check ?? 'unknown';
    if (integrity !== 'ok') throw new Error(`integrity_check failed on live db: ${integrity}`);
    const fk = await db.$queryRawUnsafe(`PRAGMA foreign_key_check`) as unknown[];
    if (Array.isArray(fk) && fk.length > 0) throw new Error(`foreign_key_check failed: ${fk.length} violations`);

    // p19 recycle guard 1: a bare live db (0 users / no users table — the
    // sandbox-recycle signature) must never replace a populated recovery
    // point. Throws → tickIfChanged logs it and retries next tick (the
    // refusal repeats loudly until the db is healed).
    await assertNotBareDb(db);

    mkdirSync(AUTO_DIR, { recursive: true });
    const target = join(AUTO_DIR, `custom-${stamp()}.db`);
    if (existsSync(target)) unlinkSync(target);
    await db.$executeRawUnsafe(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

    // Verify the snapshot itself before promoting it anywhere.
    const snapDb = new PrismaClient({
      adapter: new PrismaLibSql({ url: `file:${target}` }), // r49: Prisma 7 adapter
    });
    let tableCount = 0;
    let totalRows = 0;
    const counts: Array<{ table: string; rows: number }> = [];
    try {
      const snapIntegrity = await snapDb.$queryRawUnsafe(`PRAGMA integrity_check`) as Array<{ integrity_check: string }>;
      if (snapIntegrity[0]?.integrity_check !== 'ok') {
        throw new Error(`snapshot integrity_check failed: ${snapIntegrity[0]?.integrity_check ?? 'unknown'}`);
      }
      const tables = await snapDb.$queryRawUnsafe(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%' ORDER BY name`
      ) as Array<{ name: string }>;
      tableCount = tables.length;
      for (const t of tables) {
        const row = await snapDb.$queryRawUnsafe(`SELECT COUNT(*) AS c FROM "${t.name}"`) as Array<{ c: number | bigint }>;
        const rows = Number(row[0]?.c ?? 0);
        counts.push({ table: t.name, rows });
        totalRows += rows;
      }
    } finally {
      await snapDb.$disconnect();
    }

    // p19 recycle guard 2: a >60% row collapse vs the manifest must never
    // demote the recovery point (partial-wipe signature). The snapshot file
    // itself is kept in backups/auto — only the recovery point is protected.
    assertNoShrink(totalRows);

    refreshRecoveryPoint(target);
    updateManifest(counts, reason, statSync(target).size);
    rotate();

    return {
      ok: true,
      path: target,
      bytes: statSync(target).size,
      reason,
      integrity: 'ok',
      tableCount,
      totalRows,
      takenAt: new Date().toISOString(),
    };
  } finally {
    await db.$disconnect();
  }
}

/**
 * One watcher pass: snapshot only if the live DB file changed since the last
 * snapshot (mtime comparison — cheap stat, no DB open). Returns true if a
 * snapshot was taken. Never throws.
 */
export async function tickIfChanged(reason = 'auto-watch'): Promise<boolean> {
  try {
    const dbPath = dbFilePath();
    if (!dbPath || !existsSync(dbPath)) {
      log('live db path not resolvable/missing — nothing to do');
      return false;
    }
    const mtime = statSync(dbPath).mtimeMs;
    const state = readState();
    if (mtime <= (state.lastDbMtimeMs ?? 0)) return false; // unchanged
    const result = await takeSnapshot(reason);
    writeState({
      ...state,
      lastDbMtimeMs: mtime,
      lastSnapshotAt: result.takenAt,
      snapshotCount: (state.snapshotCount ?? 0) + 1,
    });
    log(`snapshot #${(state.snapshotCount ?? 0) + 1} OK (${result.bytes} B, ${result.tableCount} tables, ${result.totalRows} rows, ${reason})`);
    return true;
  } catch (e) {
    // never advance the watermark on failure → retried next tick
    log(`snapshot FAILED: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
