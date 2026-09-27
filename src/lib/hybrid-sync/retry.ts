/**
 * R30 hybrid sync — retry backoff.
 *
 * Exponential with full jitter: base 30 s, ×2 per attempt, capped at 30 min,
 * then ±25% random jitter so a fleet of devices that failed together (cloud
 * blip) does not retry in a synchronized thundering herd.
 */

const BASE_MS = 30_000
const CAP_MS = 30 * 60_000
const JITTER = 0.25

/** Backoff delay before the NEXT attempt, given the attempts already made. */
export function backoffMs(attempts: number): number {
  // attempts=1 (first failure) → 30 s, attempts=2 → 60 s, … capped at 30 min
  const exp = Math.min(BASE_MS * 2 ** Math.max(0, attempts - 1), CAP_MS)
  const jitter = exp * JITTER * (Math.random() * 2 - 1) // ±25%
  return Math.max(1_000, Math.round(exp + jitter))
}
