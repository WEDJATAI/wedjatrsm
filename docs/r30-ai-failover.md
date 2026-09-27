# R30 — AI Provider Failover Architecture (Hardening, Prompt 3)

**Date:** R30 · **Task:** r30-9 · **Scope:** STRICTLY ADDITIVE — no existing AI capability was removed or changed in behavior. This document is the formal failover matrix for every AI-flavored capability in the platform. Single source of truth for the chain shape: `AI_CAPABILITY_CHAINS` in `src/lib/ai/providers.ts`.

Implementation files:

| File | Role |
|---|---|
| `src/lib/ai/failover.ts` | Circuit breaker (`CircuitBreaker`, `withCircuitBreaker`, `breakerStatus`), typed `ProviderUnavailableError`, shared error taxonomy (`classifyError`, `isTransientError`), safe logging (`safeLogAIError`) — dependency-free, server-only |
| `src/lib/ai/providers.ts` | Provider chains (unchanged signatures) + `AI_CAPABILITY_CHAINS` registry + `attemptProvider` wrapper (breaker → optional transient retry → chain) |
| `src/lib/ai/config.ts` | Env key NAMES + endpoint URLs + timeouts (unchanged) |
| Consumers | `/api/ai/copilot`, `/api/ai/briefing`, `/api/ai/menu-search` (unchanged — zero route edits) |

---

## Failover Matrix

| Capability | Primary model | Fallback 1 | Fallback 2 | Failure conditions detected | Final fallback | User-visible behavior when everything above fails |
|---|---|---|---|---|---|---|
| **Manager Chat** (`POST /api/ai/copilot`, admin) | Groq · `llama-3.3-70b-versatile` (breaker `chat:groq`, 25 s timeout, 1 transient retry) | Google Gemini · `gemini-2.5-flash` (breaker `chat:gemini`, 25 s, flattened single-turn) | Platform `z-ai-web-dev-sdk` (breaker `chat:zai`, 25 s, backend-only lazy import) | timeout (AbortController 25 s / 504) · auth (HTTP 401/403) · rate-limit (HTTP 429) · server (5xx) · network (DNS/ECONN/fetch-failed) · circuit-open (instant skip) | **None** — `AiProviderError(503)` | Friendly 503 JSON: *"AI assistants are temporarily unreachable — please try again in a moment."* Never provider names, details, or keys. |
| **Daily Briefing** (`GET /api/ai/briefing`, admin, 15-min cache) | Same chat chain as Manager Chat (shared `chatWithFallback`) | ↑ | ↑ | Same classes; the 15-minute in-memory cache + `?refresh=1` further dampens provider outages | **None** — `AiProviderError(503)` | Friendly 503: *"The AI briefing service is temporarily unreachable…"*. A cached briefing (≤15 min old) keeps serving with `cached: true` even while providers are down. |
| **Menu Semantic Search** (`POST /api/ai/menu-search`, any staff) | HuggingFace MiniLM pinned endpoint (breaker `embeddings:hf:minilm`, 20 s, sticky last-working-first, 1 transient retry on first attempted endpoint) | HF router · `all-MiniLM-L6-v2` (breaker `embeddings:hf:router`, 20 s) | HF router · `BAAI/bge-small-en-v1.5` (breaker `embeddings:hf:bge-small`, 20 s) | timeout (20 s / 504) · auth (401/403) · rate-limit (429) · server (5xx) · network · circuit-open · bad payload shape (502) | **`localEmbed`** — deterministic in-process hashed-bag-of-words 256-dim vectors (never fails, works fully offline) | **Never a 503.** Results always return; `provider: 'local'` tells the UI to label keyword mode instead of semantic mode. Arabic-script queries use the local path directly (English-only HF models cannot rank Arabic). |
| **CCTV / Vision** (14 `/api/vision/*` routes) | Rule-based edge processing (frame heuristics from the camera pipeline) | — | — | **No AI provider calls exist** — no timeouts, no keys, no breakers | The rules themselves (deterministic) | No AI dependency: vision keeps operating with zero external providers. Documented here to make the boundary explicit: **no server-side model inference**. |

Chain mechanics shared by all provider-backed rows:

1. Each attempt runs under its per-`capability:provider` circuit breaker → a provider known to be dead is skipped **instantly** (`ProviderUnavailableError`) instead of burning a 20–25 s timeout on every request.
2. The **primary** provider of each chain gets ONE retry for **transient** classes only (HTTP 429, 5xx, network, timeout) with **500 ms + 0–250 ms jitter** backoff. 4xx auth errors are never retried — they go straight to the next provider and the breaker still counts them.
3. AbortController / `Promise.race` timeouts are unchanged: 25 s chat, 20 s embeddings.
4. Embedding batches always come from ONE provider per call (cosine similarity stays meaningful); product embeddings are cached 30 min per menu fingerprint.

---

## Circuit Breaker Parameters (`src/lib/ai/failover.ts`)

| Parameter | Value | Meaning |
|---|---|---|
| `BREAKER_CONSECUTIVE_THRESHOLD` | 3 | Open after 3 consecutive failures |
| `BREAKER_WINDOW_FAILURE_THRESHOLD` | 5 | …or 5 failures within the sliding window, even interleaved with successes |
| `BREAKER_WINDOW_MS` | 5 min | Sliding failure window length |
| `BREAKER_OPEN_MS` | 10 min | Open duration before a probe is allowed |
| Half-open policy | 1 probe | Exactly one probe request is admitted (concurrent callers rejected); probe success → closed + counters reset, probe failure → open again for another 10 min |
| Storage | in-memory `Map` (module scope) | Per server process — resets on restart by design (acceptable: costs at most 3 failed probes per provider after a restart) |
| Keys | `capability:provider` | `chat:groq`, `chat:gemini`, `chat:zai`, `embeddings:hf:minilm`, `embeddings:hf:router`, `embeddings:hf:bge-small` |
| Diagnostics | `breakerStatus()` | `{ key → state, openUntil, failureCount, consecutiveFailures, lastErrorClass }` — safe to expose to admins; contains **no secrets** |

## Retry Policy

| Rule | Value |
|---|---|
| Max retries per provider | 1 (primary provider only, before the chain moves on) |
| Backoff | 500 ms + uniform jitter 0–250 ms |
| Retryable classes | `TimeoutError`, `NetworkError`, `RateLimitError` (429), `ServerError` (5xx) |
| Never retried | `AuthError` (401/403), other 4xx, `CircuitOpen` |
| Interaction with the breaker | A retry goes back through `withCircuitBreaker` — if the breaker just tripped, the retry is rejected instantly (`ProviderUnavailableError`) and the chain moves on. |

## Safe-Logging Policy (`safeLogAIError`)

Every provider failure logs exactly ONE line:

```
[ai-failover] capability=chat provider=groq errorClass=RateLimitError durationMs=1234 detail="HuggingFace api-inference responded 429: …"
```

- Fields: capability, provider name, error class (taxonomy: `TimeoutError` / `NetworkError` / `RateLimitError` / `AuthError` / `ClientError` / `ServerError` / `CircuitOpen` / `UnknownError`), duration in ms, optional detail.
- Detail is scrubbed (`Bearer …`, `sk-`/`gsk_`/`hf_`/`AIza`/`xai-` key shapes, `key=`/`token=`-style assignments, `Authorization:` headers → `[redacted]`), whitespace-collapsed to one line, and truncated to **120 characters**.
- **NEVER logged:** API keys, full prompts, full provider responses, stack traces.
- `breakerStatus()` diagnostics expose only state/timestamps/counts — no secrets by construction.
- Success logging is unchanged (routes already log `[ai] copilot served by <provider> in <ms>`).

## Environment Variables (NAMES ONLY — values live in `.env`, untracked, or deployment secrets)

| Name | Used by |
|---|---|
| `GROQ_API_KEY` | Primary chat provider (Groq) |
| `GEMINI_API_KEY` | Fallback chat provider (Google Gemini) |
| `HF_API_KEY` | All three HuggingFace embedding endpoints |

Empty/missing keys degrade gracefully: the chain attempts the provider, the auth failure is breaker-counted, and after 3 requests the dead provider is skipped instantly — the app never breaks (chat falls to z-ai SDK / friendly 503; search falls to local keyword mode).

## Key Handling — Server-Side Only

- Provider keys are read **only** in server-side modules (`src/lib/ai/config.ts`), used only in server-side `fetch` calls, and never included in any API response, log line, or client bundle.
- The Electron desktop renderer cannot obtain them: `preload.js` enforces context isolation (renderer receives a marker object only, no IPC/Node access), and the AI routes run inside the bundled Next server process.
- The only client-visible AI metadata is the non-secret provider id (`'groq' | 'gemini' | 'zai'`, `'huggingface' | 'local'`) returned by the AI routes so the UI can label semantic vs keyword search mode.

## Verification Record (this round)

- `bun run lint` → **0 findings**. `bunx tsc --noEmit` → **0 new errors** (21 pre-existing legacy errors unchanged: inngest/print/round12-migrate/migrate-neon/products-reorder + the known dead R12-era loyalty pair).
- Breaker unit sanity (throwaway `scripts/ai-breaker-smoke.ts`, run with bun, deleted after capture): **14/14 PASS** — 3 consecutive failures → OPEN; 4th call rejected with `ProviderUnavailableError` **without invoking the provider fn** (call counter stayed at 3); expired open window → HALF-OPEN; successful probe → CLOSED with counters reset; 5-in-5-minutes window trip with interleaved successes; failed probe re-opens; safe-log sample line contained only `[redacted]` secret material.
- Live smoke on the dev server (no provider keys configured in this sandbox): menu-search and copilot exercised end-to-end — outcome recorded in the r30-9 worklog section (honest provider attribution).
