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
import { PrismaClient } from '@prisma/client';
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
  const db = new PrismaClient();
  try {
    const integrityRows = await db.$queryRawUnsafe(`PRAGMA integrity_check`) as Array<{ integrity_check: string }>;
    const integrity = integrityRows[0]?.integrity_check ?? 'unknown';
    if (integrity !== 'ok') throw new Error(`integrity_check failed on live db: ${integrity}`);
    const fk = await db.$queryRawUnsafe(`PRAGMA foreign_key_check`) as unknown[];
    if (Array.isArray(fk) && fk.length > 0) throw new Error(`foreign_key_check failed: ${fk.length} violations`);

    mkdirSync(AUTO_DIR, { recursive: true });
    const target = join(AUTO_DIR, `custom-${stamp()}.db`);
    if (existsSync(target)) unlinkSync(target);
    await db.$executeRawUnsafe(`VACUUM INTO '${target.replace(/'/g, "''")}'`);

    // Verify the snapshot itself before promoting it anywhere.
    const snapDb = new PrismaClient({
      datasources: { db: { url: `file:${target}` } },
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
