/**
 * r43 — build the FULL platform payload for the desktop installer.
 *
 * Runs the platform's own windows-package builder (live snapshot: the current
 * database with a CLEAN hybrid sync state + desktop-setup.mjs + the desktop
 * icon asset) and stages the ZIP where build-windows.sh expects it:
 *
 *   agent-desktop/dist/rsm-platform-payload.zip
 *
 * The installer executable embeds this ZIP after its own bytes
 * ([exe][zip][u64 len][RSMPKG1END]) — see agent-desktop/platform.ts.
 *
 *   bun scripts/r43/build-payload.ts
 */
import { copyFile, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'

import { buildWindowsPackage } from '../../src/lib/windows-package'

const OUT_DIR = path.resolve('agent-desktop/dist')
const OUT = path.join(OUT_DIR, 'rsm-platform-payload.zip')

async function main() {
  console.log('── building the full platform payload (live snapshot + clean sync state)…')
  const pkg = await buildWindowsPackage('live')
  try {
    const st = await stat(pkg.filePath)
    if (!st.isFile() || st.size < 100 * 1024) {
      throw new Error(`payload suspiciously small: ${st.size} bytes`)
    }
    await mkdir(OUT_DIR, { recursive: true })
    await copyFile(pkg.filePath, OUT)
    console.log(`✓ payload staged: ${OUT} (${(st.size / 1024 / 1024).toFixed(2)} MB)`)
  } finally {
    await pkg.cleanup()
  }
}

main().catch((err) => {
  console.error('build-payload failed:', err)
  process.exit(1)
})
