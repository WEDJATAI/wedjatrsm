#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# build-macos.sh — build the RSM Cloud Agent for macOS (Intel x64).
#
# Produces dist/RSM-macOS-Agent-Setup.zip containing:
#   RSM-macOS-Agent-Setup.app/          (the one-shot installer app)
#     Contents/Info.plist               (LSUIElement background installer)
#     Contents/MacOS/RSMCloudAgent      (bun --compile --target=bun-darwin-x64,
#                                        Mach-O x86_64, code signature INTACT —
#                                        no tail is appended on macOS)
#     Contents/Resources/RSMCFG.json    (side-car bootstrap config: hub-first)
#   README-macOS.txt                    (first-run / Gatekeeper instructions)
#
# The side-car carries the same shape as the Windows RSMCFG1 PE-overlay tail
# ({ v, baseUrl, cloudUrl, enrollKey, gen }) — on macOS the config cannot ride
# inside the binary because the embedded code signature must remain the LAST
# thing in the Mach-O file (an appended tail would invalidate it).
#
# Usage:  agent-desktop/scripts/build-macos.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT="$(cd .. && pwd)"
OUT_BIN="dist/RSM-macOS-Agent-Setup"
OUT_ZIP="dist/RSM-macOS-Agent-Setup.zip"
BUNDLE="RSM-macOS-Agent-Setup.app"
VERSION="$(grep -m1 "^const VERSION = " main.ts | sed -E "s/.*'([^']+)'.*/\1/")"

# hub + enrollment key (same values the Windows mirror bakes into its tail)
CLOUD_URL="$(grep -m1 '^VERCEL_PROD_URL=' "$ROOT/.env" | cut -d= -f2- || true)"
ENROLL_KEY="$(grep -m1 '^WINDOWS_DOWNLOAD_PASSWORD=' "$ROOT/.env" | cut -d= -f2- || true)"
CLOUD_URL="${CLOUD_URL:-https://wedjatrsm-tonsy.vercel.app}"
ENROLL_KEY="${ENROLL_KEY:-180787}"

echo "── building RSM Cloud Agent v$VERSION for macOS (Intel x64)"
echo "   hub: $CLOUD_URL"

mkdir -p dist
rm -f "$OUT_BIN" "$OUT_ZIP"
rm -rf "dist/$BUNDLE" dist/.macos-staging

echo "── 1/5 compile (bun-darwin-x64)"
bun build ./main.ts --compile --target=bun-darwin-x64 --outfile "$OUT_BIN"

echo "── 2/5 verify the Mach-O"
file "$OUT_BIN" | grep -q "Mach-O 64-bit x86_64 executable" || {
  echo "✗ not a Mach-O x86_64 executable:"; file "$OUT_BIN"; exit 1
}
bun -e '
const { readFileSync } = await import("node:fs")
const buf = readFileSync(process.argv[1])
const ncmds = buf.readUInt32LE(16)
let off = 32, sig = null
for (let i = 0; i < ncmds; i++) {
  const cmd = buf.readUInt32LE(off), size = buf.readUInt32LE(off + 4)
  if (cmd === 0x1d) { sig = { off: buf.readUInt32LE(off + 8), size: buf.readUInt32LE(off + 12) }; break }
  off += size
}
if (sig && sig.off + sig.size !== buf.length) {
  console.error(`✗ code signature [${sig.off}, ${sig.off + sig.size}) does not end at EOF ${buf.length} — binary was modified after signing`); process.exit(1)
}
console.log(`   ✓ Mach-O x86_64, ${buf.length.toLocaleString()} bytes, code signature intact (ends at EOF)`)
' "$OUT_BIN"

echo "── 3/5 package the installer .app bundle"
STAGING="dist/.macos-staging"
mkdir -p "$STAGING/$BUNDLE/Contents/MacOS" "$STAGING/$BUNDLE/Contents/Resources"
cp "$OUT_BIN" "$STAGING/$BUNDLE/Contents/MacOS/RSMCloudAgent"
chmod 755 "$STAGING/$BUNDLE/Contents/MacOS/RSMCloudAgent"
cat > "$STAGING/$BUNDLE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
        <key>CFBundleName</key><string>RSM Cloud Agent</string>
        <key>CFBundleDisplayName</key><string>RSM Cloud Agent</string>
        <key>CFBundleIdentifier</key><string>app.wedjatrsm.cloudagent</string>
        <key>CFBundleVersion</key><string>$VERSION</string>
        <key>CFBundleShortVersionString</key><string>$VERSION</string>
        <key>CFBundleExecutable</key><string>RSMCloudAgent</string>
        <key>CFBundlePackageType</key><string>APPL</string>
        <key>LSUIElement</key><true/>
        <key>LSMinimumSystemVersion</key><string>10.13</string>
        <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
# side-car bootstrap config (hub-first — the same v1.1 policy the Windows
# agent ships: the durable cloud hub is primary; there is no per-download
# origin fallback for the zip transport, by design)
cat > "$STAGING/$BUNDLE/Contents/Resources/RSMCFG.json" <<CFG
{
  "v": 1,
  "baseUrl": "$CLOUD_URL",
  "cloudUrl": "$CLOUD_URL",
  "enrollKey": "$ENROLL_KEY",
  "gen": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
CFG
cp scripts/README-macOS.txt "$STAGING/README-macOS.txt"

echo "── 4/5 zip"
(cd "$STAGING" && zip -r -q -9 "../$(basename "$OUT_ZIP")" .)

echo "── 5/5 verify the artifact"
unzip -t "$OUT_ZIP" > /dev/null && echo "   ✓ zip integrity ok"
bun -e '
const { execSync } = await import("node:child_process")
const { readFileSync } = await import("node:fs")
const zip = process.argv[1]
// extract the inner binary to a temp file and check it is byte-identical
execSync(`unzip -p "${zip}" "RSM-macOS-Agent-Setup.app/Contents/MacOS/RSMCloudAgent" > /tmp/.rsm-macos-verify-bin`)
const a = readFileSync("dist/RSM-macOS-Agent-Setup")
const b = readFileSync("/tmp/.rsm-macos-verify-bin")
if (a.length !== b.length || !a.equals(b)) { console.error("✗ inner binary differs from the built binary"); process.exit(1) }
const cfg = execSync(`unzip -p "${zip}" "RSM-macOS-Agent-Setup.app/Contents/Resources/RSMCFG.json"`).toString()
const parsed = JSON.parse(cfg)
if (!parsed.baseUrl || !parsed.cloudUrl || !parsed.enrollKey) { console.error("✗ side-car config incomplete"); process.exit(1) }
console.log(`   ✓ inner binary byte-identical (${b.length.toLocaleString()} bytes), side-car config ok (hub ${parsed.cloudUrl})`)
' "$OUT_ZIP"
rm -f /tmp/.rsm-macos-verify-bin
rm -rf "$STAGING" "$OUT_BIN"

sha256sum "$OUT_ZIP"
echo "── done: $OUT_ZIP"
