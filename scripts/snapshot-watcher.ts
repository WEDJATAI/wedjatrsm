/**
 * R21: Standalone auto-snapshot watcher — for deployment environments where
 * background processes survive (dedicated servers, VPS, the Windows package).
 *
 * NOTE (sandbox): this environment kills background shells between tool calls
 * (verified: nohup and setsid both die) — there, the equivalent watcher runs
 * INSIDE the Next.js server via src/instrumentation.ts. This script remains the
 * portable option and shares the same state file, so at most one of the two
 * mechanisms will ever take a given snapshot.
 *
 * Run:   nohup bun scripts/snapshot-watcher.ts >/dev/null 2>&1 &
 * Stop:  kill $(cat backups/auto/watcher.pid)
 * Single-instance guarded via the pid file.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tickIfChanged } from '../src/lib/db-snapshot';

// process.cwd() (not import.meta.dir — a Bun-only extension tsc doesn't know):
// this script is always run from the project root (bun scripts/… or bun run db:watch).
const ROOT = process.cwd();
const AUTO_DIR = join(ROOT, 'backups/auto');
const STATE_PATH = join(AUTO_DIR, 'watcher-state.json');
const PID_PATH = join(AUTO_DIR, 'watcher.pid');
const INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

function log(msg: string): void {
  console.log(`${new Date().toISOString()} ${msg}`);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readState(): { pid?: number; lastDbMtimeMs?: number; snapshotCount?: number } {
  try {
    if (existsSync(STATE_PATH)) return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    /* ignore */
  }
  return {};
}

// ── single-instance guard: another live watcher (standalone OR the in-app one
//    identified by a non-zero recorded pid that is not us) blocks startup ──
const previous = readState();
if (previous.pid && previous.pid !== process.pid && pidAlive(previous.pid)) {
  console.error(`[watcher] another watcher is already running (pid ${previous.pid}) — exiting`);
  process.exit(0);
}
writeFileSync(PID_PATH, `${process.pid}\n`);
const state = { ...previous, pid: process.pid };
writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');

function shutdown(signal: string): never {
  log(`watcher stopping on ${signal}`);
  try {
    if (readFileSync(PID_PATH, 'utf8').trim() === String(process.pid)) writeFileSync(PID_PATH, '');
  } catch {
    /* ignore */
  }
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

log(`standalone watcher started (pid ${process.pid}, interval ${INTERVAL_MS / 60000} min)`);
// first tick immediately: refresh the recovery point as soon as the watcher starts
void tickIfChanged('watcher-boot');
setInterval(() => void tickIfChanged('auto-watch'), INTERVAL_MS);
