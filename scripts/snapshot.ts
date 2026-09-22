/**
 * R21: Manual snapshot CLI — thin wrapper over src/lib/db-snapshot.ts.
 *
 * CLI:  bun scripts/snapshot.ts [--reason <text>]
 *
 * The same engine also runs automatically:
 *   - inside the Next.js server via src/instrumentation.ts (sandbox-safe)
 *   - via scripts/snapshot-watcher.ts in environments where background shells survive
 */
import { takeSnapshot } from '../src/lib/db-snapshot';

const args = process.argv.slice(2);
const reasonIdx = args.indexOf('--reason');
const reason = reasonIdx >= 0 ? args[reasonIdx + 1] || 'manual' : 'manual';

try {
  const result = await takeSnapshot(reason);
  console.log('[snapshot] OK', JSON.stringify(result, null, 2));
} catch (e) {
  console.error('[snapshot] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
}
