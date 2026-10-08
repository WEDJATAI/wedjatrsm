// ─── AI failover primitives (server-only) ───────────────────────────
// Circuit breaker + safe failure logging for the AI provider chains in
// ./providers.ts. This module is deliberately dependency-free (zero
// imports) so it can also run standalone in diagnostic scripts.
//
// Provides:
//   • CircuitBreaker              — per `capability:provider` key, sliding
//                                   window of failures, half-open probes
//   • withCircuitBreaker(key, fn) — run one provider attempt under the
//                                   breaker; throws ProviderUnavailableError
//                                   instantly while open (no timeout wait)
//   • breakerStatus()             — safe diagnostics (state / openUntil /
//                                   failureCount — NEVER secrets)
//   • safeLogAIError(...)         — ONE-line, secret-scrubbed failure log
//   • classifyError / isTransientError — shared error taxonomy used to
//                                   decide retry eligibility
//
// NEVER import this module from a client component. It never touches keys
// itself, but it exists to keep provider key material server-side only.

// ─── Breaker parameters ─────────────────────────────────────────────

/** Open after this many CONSECUTIVE failures. */
export const BREAKER_CONSECUTIVE_THRESHOLD = 3
/** …or this many failures inside the sliding window (any interleaving). */
export const BREAKER_WINDOW_FAILURE_THRESHOLD = 5
/** Sliding failure window length. */
export const BREAKER_WINDOW_MS = 5 * 60 * 1000
/** How long the breaker stays open before a half-open probe is allowed. */
export const BREAKER_OPEN_MS = 10 * 60 * 1000

// ─── Error taxonomy (duck-typed — no imports) ───────────────────────

export type AiErrorClass =
  | 'TimeoutError'
  | 'NetworkError'
  | 'RateLimitError' // HTTP 429
  | 'AuthError' // HTTP 401 / 403
  | 'ClientError' // other 4xx
  | 'ServerError' // 5xx
  | 'CircuitOpen'
  | 'UnknownError'

const NETWORK_RE =
  /fetch failed|network|enotfound|econnrefused|econnreset|etimedout|eai_again|socket hang up|dns|unable to connect/i

/** Classify any thrown value into the safe taxonomy above. */
export function classifyError(err: unknown): AiErrorClass {
  if (err instanceof ProviderUnavailableError) return 'CircuitOpen'
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return 'TimeoutError'
  }
  const e = err as { status?: unknown; code?: unknown; message?: unknown } | null
  if (e && typeof e === 'object') {
    if (typeof e.status === 'number' && Number.isFinite(e.status)) {
      const s = e.status
      if (s === 429) return 'RateLimitError'
      if (s === 401 || s === 403) return 'AuthError'
      if (s === 504) return 'TimeoutError'
      if (s >= 500) return 'ServerError'
      if (s >= 400) return 'ClientError'
    }
    if (typeof e.code === 'string' && NETWORK_RE.test(e.code)) return 'NetworkError'
    if (typeof e.message === 'string' && NETWORK_RE.test(e.message)) return 'NetworkError'
  }
  return 'UnknownError'
}

/** Transient classes are retry candidates (429 / 5xx / network / timeout). */
const TRANSIENT_ERROR_CLASSES: ReadonlySet<AiErrorClass> = new Set([
  'TimeoutError',
  'NetworkError',
  'RateLimitError',
  'ServerError',
])

/** 4xx auth/client errors and circuit-open skips are NEVER retried. */
export function isTransientError(err: unknown): boolean {
  return TRANSIENT_ERROR_CLASSES.has(classifyError(err))
}

// ─── Typed circuit-open error ───────────────────────────────────────

/** Thrown by withCircuitBreaker when the breaker is open — skip instantly. */
export class ProviderUnavailableError extends Error {
  readonly key: string
  readonly retryInMs: number
  constructor(key: string, retryInMs: number) {
    super(
      `AI provider circuit open for "${key}" — next probe allowed in ${Math.ceil(
        Math.max(0, retryInMs) / 1000,
      )}s`,
    )
    this.name = 'ProviderUnavailableError'
    this.key = key
    this.retryInMs = retryInMs
  }
}

// ─── Circuit breaker ────────────────────────────────────────────────

export type CircuitState = 'closed' | 'open' | 'half-open'

export type BreakerStatus = {
  key: string
  state: CircuitState
  /** ISO timestamp when the open window ends (null while closed). */
  openUntil: string | null
  /** Failures inside the current 5-minute sliding window. */
  failureCount: number
  /** Consecutive failures (reset by any success). */
  consecutiveFailures: number
  /** Last recorded error class (taxonomy label — never a raw message). */
  lastErrorClass: AiErrorClass | null
}

/**
 * Circuit breaker for one `capability:provider` key (e.g. 'chat:groq').
 * - opens after 3 consecutive failures OR 5 failures within 5 minutes
 * - stays open 10 minutes (requests fail fast with ProviderUnavailableError)
 * - then goes half-open: exactly ONE probe request is allowed; concurrent
 *   callers are rejected while the probe is in flight
 * - probe success → closed (counters reset); probe failure → open again
 * In-memory only (module scope) — resets on server restart by design.
 */
export class CircuitBreaker {
  readonly key: string
  private state: CircuitState = 'closed'
  private consecutiveFailures = 0
  private failureWindow: number[] = [] // ascending timestamps
  private openUntil = 0
  private probeInFlight = false
  private lastErrorClass: AiErrorClass | null = null

  constructor(key: string) {
    this.key = key
  }

  /** Effective state (lazily transitions open → half-open after cooldown). */
  getState(): CircuitState {
    if (this.state === 'open' && Date.now() >= this.openUntil) return 'half-open'
    return this.state
  }

  /**
   * Ask permission for one provider call. true = proceed (closed, or this
   * caller claimed the single half-open probe slot); false = fail fast.
   */
  tryAcquire(): boolean {
    const s = this.getState()
    if (s === 'closed') return true
    if (s === 'half-open') {
      if (this.probeInFlight) return false // only ONE probe at a time
      this.probeInFlight = true
      return true
    }
    return false // open
  }

  /** ms until a request may be attempted again (0 when allowed now). */
  retryInMs(): number {
    if (this.getState() === 'closed') return 0
    return Math.max(0, this.openUntil - Date.now())
  }

  /** Record a successful call: close the breaker, reset consecutive count. */
  recordSuccess(): void {
    this.state = 'closed'
    this.probeInFlight = false
    this.consecutiveFailures = 0
    this.pruneWindow() // window failures are kept — see class doc
  }

  /** Record a failed call; may trip the breaker open. */
  recordFailure(errorClass: AiErrorClass = 'UnknownError'): void {
    const now = Date.now()
    this.lastErrorClass = errorClass
    this.failureWindow.push(now)
    this.pruneWindow()
    this.consecutiveFailures += 1
    this.probeInFlight = false
    // A failed half-open probe reopens immediately; otherwise trip on
    // 3 consecutive or 5-in-5-minutes.
    const failedProbe = this.state === 'half-open' || (this.state === 'open' && now >= this.openUntil)
    if (
      failedProbe ||
      this.consecutiveFailures >= BREAKER_CONSECUTIVE_THRESHOLD ||
      this.failureWindow.length >= BREAKER_WINDOW_FAILURE_THRESHOLD
    ) {
      this.trip(now)
    }
  }

  /** Test/diagnostics hook: pretend the open window just expired. */
  expireOpenWindow(): void {
    if (this.state === 'open') this.openUntil = Date.now() - 1
  }

  /** Safe snapshot for diagnostics — no secrets, no error bodies. */
  snapshot(): BreakerStatus {
    const s = this.getState()
    return {
      key: this.key,
      state: s,
      openUntil: s === 'closed' ? null : new Date(this.openUntil).toISOString(),
      failureCount: this.failureWindow.length,
      consecutiveFailures: this.consecutiveFailures,
      lastErrorClass: this.lastErrorClass,
    }
  }

  private trip(now: number): void {
    this.state = 'open'
    this.openUntil = now + BREAKER_OPEN_MS
    this.probeInFlight = false
  }

  private pruneWindow(): void {
    const cutoff = Date.now() - BREAKER_WINDOW_MS
    while (this.failureWindow.length > 0 && this.failureWindow[0] < cutoff) {
      this.failureWindow.shift()
    }
  }
}

// Module-scoped registry (in-memory, per server process).
const breakers = new Map<string, CircuitBreaker>()

/** Get (or create) the breaker for a `capability:provider` key. */
export function getBreaker(key: string): CircuitBreaker {
  let b = breakers.get(key)
  if (!b) {
    b = new CircuitBreaker(key)
    breakers.set(key, b)
  }
  return b
}

/**
 * Run one provider attempt under its circuit breaker. While open, throws
 * ProviderUnavailableError immediately so chains skip to the next provider
 * instead of waiting for network timeouts. Success/failure is recorded.
 */
export async function withCircuitBreaker<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const breaker = getBreaker(key)
  if (!breaker.tryAcquire()) {
    throw new ProviderUnavailableError(key, breaker.retryInMs())
  }
  try {
    const result = await fn()
    breaker.recordSuccess()
    return result
  } catch (err) {
    breaker.recordFailure(classifyError(err))
    throw err
  }
}

/** Diagnostics: every known breaker key → safe status (no secrets). */
export function breakerStatus(): Record<string, BreakerStatus> {
  const out: Record<string, BreakerStatus> = {}
  for (const breaker of breakers.values()) {
    out[breaker.key] = breaker.snapshot()
  }
  return out
}

// ─── Safe failure logging ───────────────────────────────────────────

export type SafeLogContext = {
  /** Wall-clock duration of the failed attempt. */
  durationMs?: number
  /** Optional extra context — will be scrubbed + truncated like the rest. */
  detail?: string
}

// Secret-shaped patterns that must never reach the logs.
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [redacted]'],
  [/\b(?:sk-|gsk_|hf_|AIza|xai-)[A-Za-z0-9_\-]{8,}/g, '[redacted-key]'],
  [/([?&\s'"](?:key|apikey|api_key|token|access_token|secret)\s*[=:]\s*)[^\s,;&'"']+/gi, '$1[redacted]'],
  [/(authorization["'\s:=]+)[^\s,;"']+/gi, '$1[redacted]'],
]

/**
 * Scrub a detail string for logging: remove secret-shaped substrings,
 * collapse all whitespace to single spaces (ONE line guarantee) and
 * truncate to 120 characters.
 */
export function sanitizeDetail(raw: string): string {
  let s = raw
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    s = s.replace(pattern, replacement)
  }
  s = s.replace(/\s+/g, ' ').trim()
  if (s.length > 120) s = `${s.slice(0, 117)}...`
  return s
}

/**
 * Log ONE line for a failed AI provider attempt:
 *   [ai-failover] capability=chat provider=groq errorClass=RateLimitError durationMs=1234 detail="…"
 * Contains capability, provider name, error class, duration ms and an
 * optional scrubbed 120-char detail. NEVER API keys, NEVER full prompts
 * or responses, ALWAYS a single line.
 */
export function safeLogAIError(
  capability: string,
  provider: string,
  err: unknown,
  context: SafeLogContext = {},
): void {
  const errorClass = classifyError(err)
  const durationMs =
    typeof context.durationMs === 'number' && Number.isFinite(context.durationMs)
      ? Math.max(0, Math.round(context.durationMs))
      : -1
  const rawDetail =
    typeof context.detail === 'string' && context.detail.length > 0
      ? context.detail
      : err instanceof Error
        ? err.message
        : ''
  const parts = [
    '[ai-failover]',
    `capability=${capability}`,
    `provider=${provider}`,
    `errorClass=${errorClass}`,
    `durationMs=${durationMs}`,
  ]
  const detail = sanitizeDetail(rawDetail)
  if (detail.length > 0) parts.push(`detail="${detail}"`)
  console.warn(parts.join(' '))
}
