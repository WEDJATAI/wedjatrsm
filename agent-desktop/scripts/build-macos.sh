#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# build-macos.sh — build the RSM Platform installer for macOS (r58).
#
# Produces dist/RSM-Platform-Setup-macOS.zip containing:
#   RSM Platform Setup.app/                     (the one-shot installer app)
#     Contents/Info.plist                       (LSUIElement background installer)
#     Contents/MacOS/RSMPlatformSetup           (Mach-O UNIVERSAL x86_64+arm64 —
#                                                bun --compile both arches,
#                                                merged with make-universal.ts;
#                                                each slice keeps its embedded
#                                                code signature intact)
#     Contents/Resources/RSMCFG.json            (side-car bootstrap config:
#                                                hub-first + enrollment key)
#     Contents/Resources/platform-payload.zip   (the FULL platform payload —
#                                                src/, prisma/, public/, the
#                                                live db snapshot — the same
#                                                package build-windows.sh
#                                                embeds in the .exe; on macOS
#                                                it rides as a resource because
#                                                the Mach-O signature must stay
#                                                the last thing in the binary)
#   README-macOS.txt                            (first-run / Gatekeeper steps)
#
# The installed agent (~/Applications/RSM Cloud Agent.app) self-upgrades to
# the full platform: the installer copies the payload side-car into the
# installed bundle, then the supervisor extracts → installs deps → enrolls
# with the cloud → provisions two-way sync → builds → runs the full app on
# localhost:3000..3020 with the live-health dashboard on 9753.
#
# Usage:  agent-desktop/scripts/build-macos.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT="$(cd .. && pwd)"
OUT_ZIP="dist/RSM-Platform-Setup-macOS.zip"
BUNDLE="RSM Platform Setup.app"
BIN_NAME="RSMPlatformSetup"
VERSION="$(grep -m1 '^const VERSION = ' main.ts | sed -E "s/.*'([^']+)'.*/\1/")"

# hub + enrollment key (the same values build-windows.sh bakes into its tail)
CLOUD_URL="$(grep -m1 '^VERCEL_PROD_URL=' "$ROOT/.env" 2>/dev/null | cut -d= -f2- || true)"
ENROLL_KEY="$(grep -m1 '^WINDOWS_DOWNLOAD_PASSWORD=' "$ROOT/.env" 2>/dev/null | cut -d= -f2- || true)"
CLOUD_URL="${CLOUD_URL:-https://wedjatrsm-tonsy.vercel.app}"
ENROLL_KEY="${ENROLL_KEY:-180787}"

echo "── building RSM Platform installer v$VERSION for macOS (universal x64 + arm64)"
echo "   hub: $CLOUD_URL"

mkdir -p dist
rm -f "$OUT_ZIP" dist/.macos-x64 dist/.macos-arm64 dist/.macos-universal
rm -rf "dist/$BUNDLE" dist/.macos-staging

echo "── 1/7 compile the supervisor (bun-darwin-x64 + bun-darwin-arm64)"
bun build ./main.ts --compile --target=bun-darwin-x64 --outfile dist/.macos-x64
bun build ./main.ts --compile --target=bun-darwin-arm64 --outfile dist/.macos-arm64
file dist/.macos-x64 | grep -q "Mach-O 64-bit x86_64 executable" || {
  echo "✗ x64 slice is not a Mach-O x86_64 executable:"; file dist/.macos-x64; exit 1
}
file dist/.macos-arm64 | grep -q "Mach-O 64-bit arm64 executable" || {
  echo "✗ arm64 slice is not a Mach-O arm64 executable:"; file dist/.macos-arm64; exit 1
}

echo "── 2/7 merge into one universal binary"
bun scripts/make-universal.ts dist/.macos-x64 dist/.macos-arm64 dist/.macos-universal
file dist/.macos-universal | grep -q "universal binary with 2 architectures" || {
  echo "✗ not a universal binary:"; file dist/.macos-universal; exit 1
}
echo "   $(file dist/.macos-universal | sed 's/^[^:]*: //')"

echo "── 3/7 build the full platform payload (live snapshot, clean sync state)"
( cd "$ROOT" && bun scripts/r43/build-payload.ts )

echo "── 4/7 package the installer .app bundle"
STAGING="dist/.macos-staging"
mkdir -p "$STAGING/$BUNDLE/Contents/MacOS" "$STAGING/$BUNDLE/Contents/Resources"
cp dist/.macos-universal "$STAGING/$BUNDLE/Contents/MacOS/$BIN_NAME"
chmod 755 "$STAGING/$BUNDLE/Contents/MacOS/$BIN_NAME"
cat > "$STAGING/$BUNDLE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
        <key>CFBundleName</key><string>RSM Platform Setup</string>
        <key>CFBundleDisplayName</key><string>RSM Platform Setup</string>
        <key>CFBundleIdentifier</key><string>app.wedjatrsm.platformsetup</string>
        <key>CFBundleVersion</key><string>$VERSION</string>
        <key>CFBundleShortVersionString</key><string>$VERSION</string>
        <key>CFBundleExecutable</key><string>$BIN_NAME</string>
        <key>CFBundlePackageType</key><string>APPL</string>
        <key>LSUIElement</key><true/>
        <key>LSMinimumSystemVersion</key><string>10.15</string>
        <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
# side-car bootstrap config (hub-first + enrollment key — WITHOUT this the
# installed agent can never enroll, which is exactly the r58 Windows-mirror
# bug fixed in build-windows.sh --bake-config)
cat > "$STAGING/$BUNDLE/Contents/Resources/RSMCFG.json" <<CFG
{
  "v": 1,
  "baseUrl": "$CLOUD_URL",
  "cloudUrl": "$CLOUD_URL",
  "enrollKey": "$ENROLL_KEY",
  "gen": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
CFG
# the FULL platform payload rides as a bundle resource
cp dist/rsm-platform-payload.zip "$STAGING/$BUNDLE/Contents/Resources/platform-payload.zip"
cp scripts/README-macOS.txt "$STAGING/README-macOS.txt"

echo "── 5/7 zip"
(cd "$STAGING" && zip -r -q -9 "../$(basename "$OUT_ZIP")" .)

echo "── 6/7 verify the artifact"
unzip -t "$OUT_ZIP" > /dev/null && echo "   ✓ zip integrity ok"
bun -e '
const { execSync } = await import("node:child_process")
const { readFileSync } = await import("node:fs")
const zip = process.argv[1]
// the inner universal binary must be byte-identical to the merged build
execSync(`unzip -p "${zip}" "RSM Platform Setup.app/Contents/MacOS/RSMPlatformSetup" > /tmp/.rsm-macos-verify-bin`)
const a = readFileSync("dist/.macos-universal")
const b = readFileSync("/tmp/.rsm-macos-verify-bin")
if (a.length !== b.length || !a.equals(b)) { console.error("✗ inner binary differs from the built binary"); process.exit(1) }
// fat magic (big-endian 0xcafebabe) + 2 architectures
if (b.readUInt32BE(0) !== 0xcafebabe || b.readUInt32BE(4) !== 2) { console.error("✗ inner binary is not a 2-arch fat binary"); process.exit(1) }
// side-car config complete (enrollKey REQUIRED — mirrors the Windows fix)
const cfg = JSON.parse(execSync(`unzip -p "${zip}" "RSM Platform Setup.app/Contents/Resources/RSMCFG.json"`).toString())
if (!cfg.baseUrl || !cfg.cloudUrl || !cfg.enrollKey) { console.error("✗ side-car config incomplete (need baseUrl+cloudUrl+enrollKey)"); process.exit(1) }
// the full platform payload must ride as a resource with zip magic
execSync(`unzip -p "${zip}" "RSM Platform Setup.app/Contents/Resources/platform-payload.zip" > /tmp/.rsm-macos-verify-payload`)
const p = readFileSync("/tmp/.rsm-macos-verify-payload")
if (p.length < 100 * 1024 || p[0] !== 0x50 || p[1] !== 0x4b) { console.error("✗ payload side-car missing or not a zip"); process.exit(1) }
console.log(`   ✓ universal binary byte-identical (${(b.length / 1048576).toFixed(1)} MB), enrollKey baked, payload ${(p.length / 1048576).toFixed(2)} MB — hub ${cfg.cloudUrl}`)
' "$OUT_ZIP"
rm -f /tmp/.rsm-macos-verify-bin /tmp/.rsm-macos-verify-payload

echo "── 7/7 cleanup"
rm -rf "$STAGING" dist/.macos-x64 dist/.macos-arm64 dist/.macos-universal

sha256sum "$OUT_ZIP"
echo "── done: $OUT_ZIP ($(du -h "$OUT_ZIP" | cut -f1))"
