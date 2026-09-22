/**
 * R21: Server-boot hook — starts the in-app snapshot watcher on every server boot
 * (dev, production, Windows package). For an already-running server that predates
 * this file, the lazy path in src/lib/snapshot-watch-init.ts (imported by the root
 * layout and busy API routes) achieves the same thing.
 *
 * nodejs runtime only; disable with RMS_SNAPSHOT_WATCHER=0 (e.g. for CI).
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.RMS_SNAPSHOT_WATCHER === '0') return;
  try {
    await import('./lib/snapshot-watch-init');
  } catch (e) {
    console.warn('[snapshot-watcher] instrumentation failed:', e instanceof Error ? e.message : e);
  }
}
