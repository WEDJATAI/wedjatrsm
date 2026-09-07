// ─── In-memory rate limiter (per process, best-effort) ──────────────
// Simple sliding-window counters for login / attendance brute-force
// protection. Kept dependency-free; the app runs on a single node.

type Bucket = { hits: number[]; }

const buckets = new Map<string, Bucket>()
const MAX_BUCKETS = 5000

export type RateLimitResult = {
  ok: boolean
  /** seconds until the window resets (only set when blocked) */
  retryAfterSec: number
  remaining: number
}

/**
 * Count a hit against `key` and report whether it is still allowed.
 * @param key      stable identifier (e.g. `login:1.2.3.4:admin@x.com`)
 * @param max      max hits allowed inside the window
 * @param windowMs window size in milliseconds
 */
export function checkRateLimit(key: string, max: number, windowMs: number): RateLimitResult {
  const now = Date.now()
  let bucket = buckets.get(key)
  if (!bucket) {
    if (buckets.size >= MAX_BUCKETS) {
      // safety valve: drop the oldest bucket rather than grow unbounded
      const oldest = buckets.keys().next().value
      if (oldest !== undefined) buckets.delete(oldest)
    }
    bucket = { hits: [] }
    buckets.set(key, bucket)
  }
  // drop hits outside the window
  bucket.hits = bucket.hits.filter((t) => now - t < windowMs)
  if (bucket.hits.length >= max) {
    const retryAfterSec = Math.ceil((windowMs - (now - bucket.hits[0])) / 1000)
    return { ok: false, retryAfterSec: Math.max(1, retryAfterSec), remaining: 0 }
  }
  bucket.hits.push(now)
  return { ok: true, retryAfterSec: 0, remaining: max - bucket.hits.length }
}

/** Remove a key's history (e.g. after a successful attempt). */
export function resetRateLimit(key: string): void {
  buckets.delete(key)
}

/** Client IP best-effort (behind the platform gateway). */
export function clientIp(req: { headers: { get(name: string): string | null } }): string {
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  return req.headers.get('x-real-ip') ?? 'unknown'
}
