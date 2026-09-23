/**
 * R21: Lazy in-app snapshot watcher init.
 *
 * The sandbox kills every background process spawned from tool sessions (verified:
 * nohup + setsid + disown all die between calls) — only platform-started processes
 * survive, and the Next.js server is one of them. This module starts the auto-
 * snapshot interval INSIDE the server process, guarded by a global flag so it can
 * be imported from many places (instrumentation.ts, root layout, busy API routes)
 * yet only ever run once.
 *
 * It is imported for its side effect; tree-shaking must never drop it, so every
 * importer uses the literal `import '@/lib/snapshot-watch-init'` form.
 */
import { tickIfChanged } from './db-snapshot';

const INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

const g = globalThis as typeof globalThis & { __rmsSnapshotWatchInit?: boolean };

export function ensureSnapshotWatcher(): void {
  if (g.__rmsSnapshotWatchInit) return;
  g.__rmsSnapshotWatchInit = true;
  try {
    // R23: SQLite-only feature — never start on the cloud deployment
    // (DATABASE_URL = postgres://…); tickIfChanged would no-op anyway, but
    // there is no reason to run a 10-minute timer there at all.
    if (!process.env.DATABASE_URL?.startsWith('file:')) return;
    // first pass immediately: refresh the recovery point as early as possible
    void tickIfChanged('lazy-init');
    const timer = setInterval(() => void tickIfChanged('auto-watch'), INTERVAL_MS);
    // never keep the process alive just for snapshotting
    if (typeof timer.unref === 'function') timer.unref();
    console.log('[snapshot-watcher] in-app watcher started (interval 10 min)');
  } catch (e) {
    console.warn('[snapshot-watcher] failed to start:', e instanceof Error ? e.message : e);
  }
}

ensureSnapshotWatcher();
