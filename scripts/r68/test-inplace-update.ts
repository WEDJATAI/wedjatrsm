/**
 * r68 — REAL end-to-end proof of the desktop in-place app update.
 *
 * Stages a simulated pre-r68 desktop (~/.rsm-platform/platform, payload
 * version 2.6.1) and runs the agent's production update path:
 *   checkForAppUpdate() → manifest fetch (device-authenticated) → version
 *   compare (2.7.0 > 2.6.1) → payload download → sha256 verify →
 *   applyAppUpdate (extract → overlay preserving db/.env/node_modules →
 *   deps refresh → prisma generate → rebuild → restart → ready).
 *
 * Run: RSM_PLATFORM_SKIP_BUILD=1 bun scripts/r68/test-inplace-update.ts
 * (SKIP_BUILD → dev-mode restart instead of a full `next build` — the
 * machinery under test is identical, the real desktop just builds longer.)
 */
import {
  setPlatformConfig,
  checkForAppUpdate,
  appUpdateState,
  platformState,
  installedAppVersion,
} from '../../agent-desktop/platform'

async function main() {
  platformState.available = true
  setPlatformConfig({
    cloudUrl: 'http://localhost:3000',
    enrollKey: '180787',
    deviceId: '4680bc22-da4f-46f6-a527-db1db603e0a6',
    deviceKey: '65b0ece61c6b2e99dfa3fd2830de481bf16151771c5b409be061ea4f913b5ade',
  })
  console.log(`[test] staged app version BEFORE: ${installedAppVersion() ?? 'null'}`)
  const ok = await checkForAppUpdate()
  console.log(`[test] update applied: ${ok}`)
  console.log(`[test] app version AFTER: ${installedAppVersion() ?? 'null'}`)
  console.log(`[test] lastResult: ${appUpdateState.lastResult}`)
  console.log(`[test] platform status: ${platformState.status} · url: ${platformState.url ?? '—'} · mode: ${platformState.mode ?? '—'}`)
  if (!ok || installedAppVersion() !== '2.7.0') {
    console.error('[test] FAILED — the in-place update did not land at 2.7.0')
    process.exit(1)
  }
  console.log('[test] OK — in-place update proven end-to-end (2.6.1 → 2.7.0, no installer)')
}

main().catch((err) => {
  console.error('[test] failed:', err)
  process.exit(1)
})
