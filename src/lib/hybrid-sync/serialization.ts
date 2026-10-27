/**
 * R30 hybrid sync — canonical serialization + hashing.
 *
 * Deterministic JSON is the foundation of the whole engine: two devices that
 * hold the same row produce the SAME canonical payload string, so payload
 * hashes are comparable across instances and revisions are meaningful.
 */
import { createHash } from 'node:crypto'

/**
 * Canonical JSON: object keys recursively sorted, no whitespace, UTF-8.
 * Arrays keep their order (order is data). Values that are not JSON-native
 * (Date, undefined) are normalized: Date → ISO string, undefined → dropped
 * from objects, undefined inside arrays → null.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value))
}

function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (value === undefined) return null
  if (value === null) return null
  if (Array.isArray(value)) return value.map(normalize)
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key]
      if (v === undefined) continue // undefined keys never ride the wire
      out[key] = normalize(v)
    }
    return out
  }
  return value
}

/** SHA-256 hex digest of a string (payload hashes, device key hashes). */
export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

/**
 * Deterministic hex comparison: true when hexA > hexB (lowercase expected;
 * comparison is done case-insensitively so a sloppy peer cannot flip a
 * tiebreak by uppercasing its hash).
 */
export function hexGreater(hexA: string, hexB: string): boolean {
  const a = hexA.toLowerCase()
  const b = hexB.toLowerCase()
  return a.length === b.length ? a > b : a.length > b.length
}
