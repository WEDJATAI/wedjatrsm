/**
 * r43 — generate the Windows desktop icon (agent-desktop/resources/platform.ico)
 * from the platform's master icon (desktop/resources/icon.png, 1024×1024).
 *
 * Produces a multi-size ICO with PNG-compressed entries (256/64/48/32/16 —
 * supported by every Windows since Vista): ICONDIR + one ICONDIRENTRY per
 * size + the raw PNG bytes. Run once (or whenever the master icon changes):
 *
 *   bun scripts/r43/make-ico.ts
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import sharp from 'sharp'

const SRC = path.resolve('desktop/resources/icon.png')
const OUT_DIR = path.resolve('agent-desktop/resources')
const OUT = path.join(OUT_DIR, 'platform.ico')

const SIZES = [256, 64, 48, 32, 16] as const

async function main() {
  const png = await readFile(SRC)
  const entries: Array<{ size: number; data: Buffer }> = []
  for (const size of SIZES) {
    const data = await sharp(png).resize(size, size, { fit: 'cover' }).png().toBuffer()
    entries.push({ size, data })
  }

  // ── ICO container (little-endian) ──
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(entries.length, 4) // image count

  const dirLen = 16 * entries.length
  let offset = 6 + dirLen
  const dirs: Buffer[] = []
  for (const e of entries) {
    const d = Buffer.alloc(16)
    d.writeUInt8(e.size >= 256 ? 0 : e.size, 0) // width (0 = 256)
    d.writeUInt8(e.size >= 256 ? 0 : e.size, 1) // height
    d.writeUInt8(0, 2) // palette
    d.writeUInt8(0, 3) // reserved
    d.writeUInt16LE(1, 4) // color planes
    d.writeUInt16LE(32, 6) // bits per pixel
    d.writeUInt32LE(e.data.length, 8) // bytes
    d.writeUInt32LE(offset, 12) // offset
    offset += e.data.length
    dirs.push(d)
  }

  const ico = Buffer.concat([header, ...dirs, ...entries.map((e) => e.data)])
  await mkdir(OUT_DIR, { recursive: true })
  await writeFile(OUT, ico)
  console.log(`platform.ico written: ${OUT} (${(ico.length / 1024).toFixed(1)} KB, ${SIZES.length} sizes)`)
}

main().catch((err) => {
  console.error('make-ico failed:', err)
  process.exit(1)
})
