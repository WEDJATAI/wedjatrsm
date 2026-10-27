/**
 * make-universal.ts — merge two single-arch Mach-O executables into ONE
 * universal (fat) binary. r58: the sandbox (and most Linux CI) has no Apple
 * `lipo`, but the fat-binary container format is simple and fully
 * documented — this joiner writes it directly:
 *
 *   [fat header (big-endian)] [fat_arch × 2] [x86_64 slice] [arm64 slice]
 *
 *     magic 0xcafebabe · nfat_arch
 *     fat_arch { cputype, cpusubtype, offset, size, align } (all big-endian)
 *
 * Each bun --compile slice is copied VERBATIM, so its embedded (ad-hoc) code
 * signature keeps covering exactly the same bytes it was generated over —
 * the same property lipo preserves. Slices are aligned: x86_64 → 2^12,
 * arm64 → 2^14.
 *
 * Usage: bun agent-desktop/scripts/make-universal.ts <x64-bin> <arm64-bin> <out>
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs'

const MH_MAGIC_64 = 0xfeedfacf
const LC_CODE_SIGNATURE = 0x1d
const CPU_TYPE_X86_64 = 0x01000007
const CPU_TYPE_ARM64 = 0x0100000c
const CPU_SUBTYPE_X86_64_ALL = 3
const CPU_SUBTYPE_ARM64_ALL = 0
const FAT_MAGIC = 0xcafebabe
const ALIGN_X86_64 = 12 // 2^12 = 4096
const ALIGN_ARM64 = 14 // 2^14 = 16384

const [x64Path, arm64Path, outPath] = process.argv.slice(2)
if (!x64Path || !arm64Path || !outPath) {
  console.error('usage: make-universal.ts <x64-bin> <arm64-bin> <out>')
  process.exit(1)
}

/** Validate a 64-bit LE Mach-O of the expected cputype; also verify its
 *  embedded code signature (if any) ends exactly at the slice's EOF — i.e.
 *  the binary was not modified after signing (same check build-macos.sh
 *  runs on single-arch output). */
function checkSlice(buf: Buffer, label: string, cputype: number): void {
  if (buf.length < 32) fail(`${label}: too small (${buf.length} bytes)`)
  if (buf.readUInt32LE(0) !== MH_MAGIC_64) fail(`${label}: not a 64-bit little-endian Mach-O`)
  const type = buf.readInt32LE(4)
  if (type !== cputype) {
    fail(`${label}: cputype 0x${(type >>> 0).toString(16)} ≠ expected 0x${(cputype >>> 0).toString(16)}`)
  }
  const ncmds = buf.readUInt32LE(16)
  let off = 32
  for (let i = 0; i < ncmds; i++) {
    if (off + 8 > buf.length) fail(`${label}: truncated load commands`)
    const cmd = buf.readUInt32LE(off)
    const size = buf.readUInt32LE(off + 4)
    if (size < 8 || off + size > buf.length) fail(`${label}: malformed load command ${i}`)
    if (cmd === LC_CODE_SIGNATURE) {
      const sigOff = buf.readUInt32LE(off + 8)
      const sigSize = buf.readUInt32LE(off + 12)
      if (sigOff + sigSize !== buf.length) {
        fail(`${label}: code signature [${sigOff}, ${sigOff + sigSize}) does not end at EOF ${buf.length} — binary modified after signing`)
      }
      console.log(`   ✓ ${label}: Mach-O 64-bit, ${buf.length.toLocaleString()} bytes, code signature intact (ends at EOF)`)
      return
    }
    off += size
  }
  console.log(`   ✓ ${label}: Mach-O 64-bit, ${buf.length.toLocaleString()} bytes, no embedded signature (unsigned)`)
}

function fail(msg: string): never {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

const x64 = readFileSync(x64Path)
const arm64 = readFileSync(arm64Path)
checkSlice(x64, x64Path, CPU_TYPE_X86_64)
checkSlice(arm64, arm64Path, CPU_TYPE_ARM64)

// fat header (8 bytes) + 2 × fat_arch (20 bytes each), then aligned slices
const headerSize = 8 + 2 * 20
const alignUp = (v: number, align: number) => Math.ceil(v / 2 ** align) * 2 ** align
const offX64 = alignUp(headerSize, ALIGN_X86_64)
const offArm64 = alignUp(offX64 + x64.length, ALIGN_ARM64)
const total = offArm64 + arm64.length

const out = Buffer.alloc(total)
out.writeUInt32BE(FAT_MAGIC, 0)
out.writeUInt32BE(2, 4)
// fat_arch #1 — x86_64
out.writeInt32BE(CPU_TYPE_X86_64, 8)
out.writeInt32BE(CPU_SUBTYPE_X86_64_ALL, 12)
out.writeUInt32BE(offX64, 16)
out.writeUInt32BE(x64.length, 20)
out.writeUInt32BE(ALIGN_X86_64, 24)
// fat_arch #2 — arm64
out.writeInt32BE(CPU_TYPE_ARM64, 28)
out.writeInt32BE(CPU_SUBTYPE_ARM64_ALL, 32)
out.writeUInt32BE(offArm64, 36)
out.writeUInt32BE(arm64.length, 40)
out.writeUInt32BE(ALIGN_ARM64, 44)
// the slices, verbatim
x64.copy(out, offX64)
arm64.copy(out, offArm64)

writeFileSync(outPath, out)
const st = statSync(outPath)
console.log(`✓ universal binary: ${outPath} (${(st.size / 1048576).toFixed(1)} MB — x86_64 @${offX64}, arm64 @${offArm64})`)
