#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# build-windows.sh — build the FULL Windows desktop version installer (r43).
#
# Produces agent-desktop/dist/RSM-Platform-Setup.exe — a single executable
# (bun --compile --target=bun-windows-x64, Bun runtime embedded, zero
# dependencies on the target PC) with the COMPLETE platform payload appended
# after the executable bytes:
#
#   [bun exe ~94 MB][payload zip][u64 LE zip length]["RSMPKG1END"]
#        │                │
#        │                └─ the whole app: src/, prisma/, public/, configs,
#        │                   db/custom.db (live snapshot, CLEAN hybrid sync
#                   state), windows/*.bat, desktop-setup.mjs,
#                   agent-assets/platform.ico
#        └─ the supervisor: self-installs, creates the "RSM Platform"
#           desktop icon, enrolls with the cloud, provisions two-way sync,
#           builds + supervises the server, serves the dashboard on 9753
#
# Per-download RSMCFG1 config tails are appended at STREAM time by
# /api/download/windows (origin-first + durable cloud fallback) — the baked
# artifact here carries no config tail, so the same file serves both the
# local-stream and the GitHub mirror (the mirror copy gets a baked durable
# config via --bake-config, see below).
#
# Usage:
#   agent-desktop/scripts/build-windows.sh                 # exe + payload
#   agent-desktop/scripts/build-windows.sh --bake-config   # + baked RSMCFG1
#                                                          #   (GitHub mirror)
#   agent-desktop/scripts/build-windows.sh --skip-payload  # companion only
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."

ROOT="$(cd .. && pwd)"
OUT_EXE="dist/RSM-Platform-Setup.exe"
PAYLOAD="dist/rsm-platform-payload.zip"
VERSION="$(grep -m1 '^const VERSION = ' main.ts | sed -E "s/.*'([^']+)'.*/\1/")"

BAKE_CONFIG=0
SKIP_PAYLOAD=0
for arg in "$@"; do
  case "$arg" in
    --bake-config) BAKE_CONFIG=1 ;;
    --skip-payload) SKIP_PAYLOAD=1 ;;
  esac
done

# hub + enrollment key (same values the macOS build bakes into its side-car)
CLOUD_URL="$(grep -m1 '^VERCEL_PROD_URL=' "$ROOT/.env" 2>/dev/null | cut -d= -f2- || true)"
CLOUD_URL="${CLOUD_URL:-https://wedjatrsm-tonsy.vercel.app}"

echo "── building RSM Platform installer v$VERSION for Windows (x64)"
echo "   hub: $CLOUD_URL"
mkdir -p dist
rm -f "$OUT_EXE"

echo "── 1/5 compile the supervisor (bun-windows-x64)"
bun build ./main.ts --compile --target=bun-windows-x64 --outfile "$OUT_EXE"
echo "   exe: $(du -h "$OUT_EXE" | cut -f1)"

echo "── 2/5 verify the PE header"
file "$OUT_EXE" | grep -q "PE32+ executable" && file "$OUT_EXE" | grep -q "x86-64" || {
  echo "✗ not a Windows x64 executable:"; file "$OUT_EXE"; exit 1
}

if [ "$SKIP_PAYLOAD" -eq 1 ]; then
  echo "── payload skipped (--skip-payload) — companion-only build"
  echo "✓ $OUT_EXE"
  exit 0
fi

echo "── 3/5 build the platform payload (live snapshot, clean sync state)"
( cd "$ROOT" && bun scripts/r43/build-payload.ts )

echo "── 4/5 append the payload block ([zip][u64 len][RSMPKG1END])"
bun -e '
const { appendFileSync, statSync, readFileSync } = await import("node:fs")
const exe = process.argv[1], zip = process.argv[2]
const zipBytes = readFileSync(zip)
const len = Buffer.alloc(8)
len.writeBigUInt64LE(BigInt(zipBytes.length))
appendFileSync(exe, Buffer.concat([zipBytes, len, Buffer.from("RSMPKG1END")]))
const total = statSync(exe).size
console.log(`   payload ${(zipBytes.length / 1048576).toFixed(2)} MB → exe total ${(total / 1048576).toFixed(1)} MB`)
' "$OUT_EXE" "$PAYLOAD"

if [ "$BAKE_CONFIG" -eq 1 ]; then
  echo "── 5/5 bake the durable-cloud RSMCFG1 config tail (mirror artifact)"
  bun -e '
const { appendFileSync } = await import("node:fs")
const cfg = JSON.stringify({ v: 1, baseUrl: process.argv[1], cloudUrl: process.argv[1], gen: new Date().toISOString() })
appendFileSync(process.argv[2], Buffer.from("\nRSMCFG1:" + Buffer.from(cfg).toString("base64")))
' "$CLOUD_URL" "$OUT_EXE"
else
  echo "── 5/5 skipped config tail (stream-time RSMCFG1 appended per download)"
fi

echo "── verifying the embedded payload reads back"
bun -e '
const { openSync, fstatSync, readSync, closeSync } = await import("node:fs")
const fd = openSync(process.argv[1], "r")
try {
  const size = fstatSync(fd).size
  const win = Math.min(48 * 1024 * 1024, size)
  const base = size - win
  const buf = Buffer.alloc(win)
  readSync(fd, buf, 0, win, base)
  const idx = buf.lastIndexOf("RSMPKG1END")
  if (idx < 0) { console.error("✗ RSMPKG1END marker not found"); process.exit(1) }
  const zipLen = Number(buf.readBigUInt64LE(idx - 8))
  const start = base + idx - 8 - zipLen
  const magic = Buffer.alloc(4)
  readSync(fd, magic, 0, 4, start)
  if (magic[0] !== 0x50 || magic[1] !== 0x4b) { console.error("✗ payload PK magic mismatch"); process.exit(1) }
  console.log(`✓ payload verified: ${(zipLen / 1048576).toFixed(2)} MB at offset ${start}`)
} finally { closeSync(fd) }
' "$OUT_EXE"

echo "✓ $OUT_EXE ($(du -h "$OUT_EXE" | cut -f1)) — the FULL desktop version"
