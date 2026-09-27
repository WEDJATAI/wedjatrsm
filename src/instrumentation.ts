/**
 * R21: Server-boot hook — starts the in-app snapshot watcher on every server boot
 * (dev, production, Windows package). For an already-running server that predates
 * this file, the lazy path in src/lib/snapshot-watch-init.ts (imported by the root
 * layout and busy API routes) achieves the same thing.
 *
 * nodejs runtime only; disable with RMS_SNAPSHOT_WATCHER=0 (e.g. for CI).
 *
 * R30: the local-first hybrid sync engine boots here too (same pattern, own
 * kill-switch RMS_HYBRID_WATCHER=0): a staged restore is applied first (file
 * swap — see hybrid-engine.ts), then the 30 s push/pull engine starts.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // R30: hybrid sync engine + staged-restore applier — SQLite-only (the
  // engine exchanges events with the cloud; the cloud deployment itself is
  // the TARGET, not a sync initiator) and disable-able for CI/one-shot runs.
  if (process.env.RMS_HYBRID_WATCHER !== '0' && process.env.DATABASE_URL?.startsWith('file:')) {
    try {
      const hybrid = await import('./lib/hybrid-sync/hybrid-engine');
      await hybrid.applyStagedRestoreAtBoot();
      hybrid.startHybridEngine();
    } catch (e) {
      console.warn('[hybrid-engine] instrumentation failed:', e instanceof Error ? e.message : e);
    }
  }

  if (process.env.RMS_SNAPSHOT_WATCHER === '0') return;
  // R23: the snapshot engine is SQLite-only — on the cloud deployment
  // (DATABASE_URL = postgres://…) there is no db file to watch. Backups
  // there are Neon's PITR + the Turso replica instead.
  if (!process.env.DATABASE_URL?.startsWith('file:')) return;
  try {
    await import('./lib/snapshot-watch-init');
  } catch (e) {
    console.warn('[snapshot-watcher] instrumentation failed:', e instanceof Error ? e.message : e);
  }
}
