// ─── AI providers (server-only) ─────────────────────────────────────
// P15 consensus architecture — five providers, z.ai fully REMOVED:
//   • chat:     groq → openrouter → nvidia → gemini → huggingface
//               (cross-provider failover chain) — every provider holds
//               a MODEL LIST: if one model fails (404/410/400 gone,
//               per-model 429/5xx/timeout) the provider chooses its
//               next model; if the provider itself fails (401 dead key,
//               breaker open, every model exhausted) the chain moves on.
//   • consensus: chatWithConsensus() fires the primary model of every
//               configured provider IN PARALLEL, then picks the medoid
//               answer (highest average token-overlap agreement with
//               the other votes) — "all AI models work in consensus".
//   • search:   HuggingFace MiniLM (pinned endpoints) → HF bge-small
//               alternate model → deterministic local hashed-bag-of-words
//               fallback (never fails, keeps search usable offline)
// All external requests are plain `fetch` with AbortController timeouts —
// no extra packages. Keys come from ./config (env-first) and never
// leave the server. Reasoning models (nemotron, DeepSeek, Qwen3) are
// handled: content ?? reasoning_content ?? reasoning.
//
// R30 failover hardening (kept): every provider attempt runs under a
// per-model circuit breaker (./failover) so a dead provider/model is
// skipped instantly instead of retried on every request; the FIRST
// model of each provider gets ONE transient retry (429/5xx/network —
// never 4xx auth) with 500ms + jitter backoff; every failure is logged
// through safeLogAIError (one line, secret-free).

import {
  GROQ_API_KEY,
  GROQ_API_URL,
  GROQ_MODELS,
  OPENROUTER_API_KEY,
  OPENROUTER_API_URL,
  OPENROUTER_MODELS,
  NVIDIA_API_KEY,
  NVIDIA_API_URL,
  NVIDIA_MODELS,
  GEMINI_API_KEY,
  GEMINI_API_URL,
  GEMINI_MODELS,
  HF_API_KEY,
  HF_CHAT_API_URL,
  HF_CHAT_MODELS,
  HF_API_URL,
  HF_ROUTER_URL,
  HF_ALT_EMBED_URL,
  HF_EMBED_MODEL,
  AI_CHAT_TIMEOUT_MS,
  AI_CHAT_PRIMARY_TIMEOUT_MS,
  AI_CONSENSUS_TIMEOUT_MS,
  AI_EMBED_TIMEOUT_MS,
  EMBED_CACHE_MAX_ENTRIES,
  EMBED_CACHE_TTL_MS,
} from './config'
import {
  ProviderUnavailableError,
  breakerStatus,
  isTransientError,
  safeLogAIError,
  withCircuitBreaker,
  type BreakerStatus,
} from './failover'

// ─── Errors ─────────────────────────────────────────────────────────

/** Raised when a single provider (or the whole chain) fails. */
export class AiProviderError extends Error {
  status: number
  provider: string
  constructor(message: string, status = 502, provider = 'unknown') {
    super(message)
    this.name = 'AiProviderError'
    this.status = status
    this.provider = provider
  }
}

// ─── Types ──────────────────────────────────────────────────────────

export type ChatRole = 'user' | 'assistant'
export type ChatMessage = { role: ChatRole; content: string }

export type ChatOpts = {
  system?: string
  temperature?: number
  maxTokens?: number
  /** Per-attempt timeout override (consensus rounds use the shorter one). */
  timeoutMs?: number
  /** Allow the one transient retry on the first model (default true; consensus disables it — the medoid tolerates a missing vote). */
  retry?: boolean
}

export type ChatProvider = 'groq' | 'openrouter' | 'nvidia' | 'gemini' | 'huggingface'
export type EmbedProvider = 'huggingface' | 'local'

// ─── Shared fetch helper (AbortController timeout) ──────────────────

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: 'no-store' })
  } finally {
    clearTimeout(timer)
  }
}

function statusFromError(err: unknown, fallback = 502): number {
  if (err instanceof AiProviderError) return err.status
  if (err instanceof Error && err.name === 'AbortError') return 504
  return fallback
}

function briefError(err: unknown): string {
  if (err instanceof AiProviderError) return `${err.provider}: ${err.message} (${err.status})`
  if (err instanceof Error && err.name === 'AbortError') return 'timeout'
  if (err instanceof Error) return err.message.slice(0, 160)
  return String(err).slice(0, 160)
}

// ─── Provider registry (single source of truth) ─────────────────────

type ProviderDefinition = {
  id: ChatProvider
  label: string
  kind: 'openai-compat' | 'gemini-native'
  apiKey: string
  url: string
  models: readonly string[]
}

/**
 * The five chat providers in failover-chain order. Keys resolve env-first;
 * an empty key marks the provider 'unconfigured' (skipped — Groq and
 * Gemini-direct are key-dead at p15 time and stay listed so a fresh key
 * re-arms them with zero code changes).
 */
const CHAT_PROVIDERS: readonly ProviderDefinition[] = [
  {
    id: 'groq',
    label: 'Groq',
    kind: 'openai-compat',
    apiKey: GROQ_API_KEY,
    url: GROQ_API_URL,
    models: GROQ_MODELS,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai-compat',
    apiKey: OPENROUTER_API_KEY,
    url: OPENROUTER_API_URL,
    models: OPENROUTER_MODELS,
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    kind: 'openai-compat',
    apiKey: NVIDIA_API_KEY,
    url: NVIDIA_API_URL,
    models: NVIDIA_MODELS,
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    kind: 'gemini-native',
    apiKey: GEMINI_API_KEY,
    url: GEMINI_API_URL,
    models: GEMINI_MODELS,
  },
  {
    id: 'huggingface',
    label: 'HuggingFace',
    kind: 'openai-compat',
    apiKey: HF_API_KEY,
    url: HF_CHAT_API_URL,
    models: HF_CHAT_MODELS,
  },
]

/** Breaker key for one provider+model pair ('chat:openrouter:google/gemma-4-31b-it'). */
function modelBreakerKey(def: ProviderDefinition, model: string): string {
  return `chat:${def.id}:${model}`
}

/** Sticky "last model that worked" per provider (skip known-dead primaries). */
const lastWorkingModel = new Map<ChatProvider, string>()

/** Model order for a provider: the last WORKING model first, then the rest. */
function orderedModels(def: ProviderDefinition): string[] {
  const sticky = lastWorkingModel.get(def.id)
  if (!sticky) return [...def.models]
  return [sticky, ...def.models.filter((m) => m !== sticky)]
}

// ─── Capability→chain registry (single source of truth) ─────────────

export type AIChainEntry = {
  /** Registry id — matches the provider registry ('groq', 'openrouter', …). */
  provider: string
  /** Human label for docs/UI. */
  label: string
  /** Model list served by this step (tried in order — model-level failover). */
  models: string[]
  /** Per-attempt timeout (AbortController). */
  timeoutMs: number
  /** Circuit breaker key prefix ('chat:groq:…' — one breaker PER MODEL). */
  breakerKey: string
}

export type AIChainDefinition = {
  entries: AIChainEntry[]
  retryPolicy: {
    maxRetries: number
    backoffBaseMs: number
    backoffJitterMs: number
    transientOnly: boolean
  }
  finalFallback: string
}

/**
 * Formal capability → provider chain registry (single source of truth for
 * docs and UI). Entry order = fallback order:
 *   chat:       groq → openrouter → nvidia → gemini → huggingface
 *   consensus:  every configured provider fires in PARALLEL; the medoid
 *               (most-agreed) answer wins; briefing reports the vote.
 *   embeddings: hf:minilm → hf:router → hf:bge-small → local (never fails)
 * The embeddings chain additionally tries the last WORKING endpoint first
 * (sticky reorder inside embedTexts). Vision/CCTV is deliberately absent:
 * it is rule-based edge processing with no server-side model inference.
 */
export const AI_CAPABILITY_CHAINS: Readonly<{
  chat: AIChainDefinition
  consensus: AIChainDefinition
  embeddings: AIChainDefinition
}> = {
  chat: {
    entries: CHAT_PROVIDERS.map((def) => ({
      provider: def.id,
      label: def.label,
      models: [...def.models],
      timeoutMs: AI_CHAT_TIMEOUT_MS,
      breakerKey: `chat:${def.id}`,
    })),
    retryPolicy: {
      maxRetries: 1,
      backoffBaseMs: 500,
      backoffJitterMs: 250,
      transientOnly: true,
    },
    finalFallback:
      'All chat providers down → AiProviderError(503) → routes answer with a friendly "AI temporarily unreachable" message (never provider details or keys).',
  },
  consensus: {
    entries: CHAT_PROVIDERS.map((def) => ({
      provider: def.id,
      label: def.label,
      models: [def.models[0]],
      timeoutMs: AI_CHAT_PRIMARY_TIMEOUT_MS,
      breakerKey: `chat:${def.id}`,
    })),
    retryPolicy: {
      maxRetries: 0, // parallel fan-out — the medoid tolerates a missing vote
      backoffBaseMs: 0,
      backoffJitterMs: 0,
      transientOnly: true,
    },
    finalFallback:
      'Zero votes in a consensus round → sequential chain retry (chat) → still zero → friendly 503.',
  },
  embeddings: {
    entries: [
      {
        provider: 'hf:minilm',
        label: 'HuggingFace MiniLM (pinned endpoint)',
        models: [HF_EMBED_MODEL],
        timeoutMs: AI_EMBED_TIMEOUT_MS,
        breakerKey: 'embeddings:hf:minilm',
      },
      {
        provider: 'hf:router',
        label: 'HuggingFace router (MiniLM)',
        models: [HF_EMBED_MODEL],
        timeoutMs: AI_EMBED_TIMEOUT_MS,
        breakerKey: 'embeddings:hf:router',
      },
      {
        provider: 'hf:bge-small',
        label: 'HuggingFace bge-small alternate',
        models: ['BAAI/bge-small-en-v1.5'],
        timeoutMs: AI_EMBED_TIMEOUT_MS,
        breakerKey: 'embeddings:hf:bge-small',
      },
      {
        provider: 'local',
        label: 'Local deterministic fallback',
        models: ['hashed bag-of-words, 256-dim'],
        timeoutMs: 0,
        breakerKey: '', // in-process and cannot fail → no breaker needed
      },
    ],
    retryPolicy: {
      maxRetries: 1,
      backoffBaseMs: 500,
      backoffJitterMs: 250,
      transientOnly: true,
    },
    finalFallback:
      'localEmbed — deterministic in-process hashed-bag-of-words vectors; menu search degrades from semantic to keyword mode but never fails.',
  },
}

// ─── Breaker + retry wrapper (R30) ──────────────────────────────────

/** ONE transient retry on the first model of a provider, 500ms + jitter. */
const TRANSIENT_RETRY_BASE_MS = 500
const TRANSIENT_RETRY_JITTER_MS = 250

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

type AttemptOpts = {
  capability: 'chat' | 'embeddings'
  /** Registry provider id ('groq', 'hf:minilm', …) — used for logging. */
  provider: string
  /** First models get the one transient retry; the rest do not. */
  allowRetry: boolean
}

/**
 * Run ONE provider attempt under its circuit breaker, preserving the
 * AbortController timeouts inside fn. On failure: log one safe line
 * (safeLogAIError); when the failure is transient (429/5xx/network/
 * timeout) and retries are allowed, back off 500ms + jitter and retry
 * ONCE. 401 auth errors and circuit-open skips return straight to the
 * caller — the chain moves on and the breaker has already counted it.
 */
async function attemptProvider<T>(
  breakerKey: string,
  fn: () => Promise<T>,
  opts: AttemptOpts,
): Promise<T> {
  const started = Date.now()
  try {
    return await withCircuitBreaker(breakerKey, fn)
  } catch (err) {
    safeLogAIError(opts.capability, opts.provider, err, {
      durationMs: Date.now() - started,
    })
    if (
      !opts.allowRetry ||
      err instanceof ProviderUnavailableError ||
      !isTransientError(err)
    ) {
      throw err
    }
    await sleep(TRANSIENT_RETRY_BASE_MS + Math.random() * TRANSIENT_RETRY_JITTER_MS)
    const retryStarted = Date.now()
    try {
      return await withCircuitBreaker(breakerKey, fn)
    } catch (retryErr) {
      safeLogAIError(opts.capability, opts.provider, retryErr, {
        durationMs: Date.now() - retryStarted,
        detail: 'transient retry exhausted',
      })
      throw retryErr
    }
  }
}

// ─── OpenAI-compatible chat (groq / openrouter / nvidia / huggingface)

type OpenAiMessage = { role: string; content: string }
type OpenAiChoice = {
  message?: {
    content?: unknown
    reasoning_content?: unknown
    reasoning?: unknown
  }
}

/**
 * One chat completion against any OpenAI-compatible endpoint. Handles
 * reasoning models (content ?? reasoning_content ?? reasoning) and
 * returns the trimmed text.
 */
async function openAiCompatChat(
  def: ProviderDefinition,
  model: string,
  messages: ChatMessage[],
  opts: ChatOpts,
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? AI_CHAT_TIMEOUT_MS
  const payload: Record<string, unknown> = {
    model,
    messages: opts.system
      ? ([{ role: 'system', content: opts.system }] as OpenAiMessage[]).concat(messages)
      : messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 700,
  }

  let res: Response
  try {
    res = await fetchWithTimeout(
      def.url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${def.apiKey}`,
        },
        body: JSON.stringify(payload),
      },
      timeoutMs,
    )
  } catch (err) {
    throw new AiProviderError(
      `${def.label} request failed (${briefError(err)})`,
      statusFromError(err),
      def.id,
    )
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new AiProviderError(
      `${def.label} [${model}] responded ${res.status}: ${body.slice(0, 200)}`,
      res.status,
      def.id,
    )
  }

  const data: unknown = await res.json().catch(() => null)
  const choices = (data as { choices?: unknown } | null)?.choices
  if (Array.isArray(choices) && choices.length > 0) {
    const msg = (choices[0] as OpenAiChoice | undefined)?.message
    // reasoning models can leave content null and answer in reasoning_content
    for (const field of [msg?.content, msg?.reasoning_content, msg?.reasoning]) {
      if (typeof field === 'string' && field.trim().length > 0) return field.trim()
    }
  }
  throw new AiProviderError(
    `${def.label} [${model}] returned an empty completion`,
    502,
    def.id,
  )
}

// ─── Gemini (native generateContent) ────────────────────────────────

/** Single-turn chat via Gemini generateContent (system instruction + prompt). */
async function geminiNativeChat(
  model: string,
  messages: ChatMessage[],
  opts: ChatOpts,
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? AI_CHAT_TIMEOUT_MS
  const url = `${GEMINI_API_URL.replace(/models\/[^:]+:/, `models/${model}:`)}`
  const prompt = messages.map((m) => m.content).join('\n\n')
  const payload: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    systemInstruction: { parts: [{ text: opts.system ?? 'You are a helpful assistant.' }] },
    generationConfig: {
      temperature: opts.temperature ?? 0.3,
      maxOutputTokens: opts.maxTokens ?? 700,
    },
  }

  // The supplied key format may be AIza… or the newer AQ.… — try the
  // x-goog-api-key header first, then the ?key= query-param variant.
  const attempts: { url: string; headers: Record<string, string> }[] = [
    { url, headers: { 'x-goog-api-key': GEMINI_API_KEY } },
    { url: `${url}?key=${encodeURIComponent(GEMINI_API_KEY)}`, headers: {} },
  ]

  let lastStatus = 502
  let lastDetail = 'no response'
  for (const attempt of attempts) {
    let res: Response
    try {
      res = await fetchWithTimeout(
        attempt.url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...attempt.headers },
          body: JSON.stringify(payload),
        },
        timeoutMs,
      )
    } catch (err) {
      lastStatus = statusFromError(err)
      lastDetail = briefError(err)
      continue
    }
    if (!res.ok) {
      lastStatus = res.status
      lastDetail = (await res.text().catch(() => '')).slice(0, 200)
      if (res.status === 401 || res.status === 403) continue
      break
    }
    const data: unknown = await res.json().catch(() => null)
    const candidates = (data as { candidates?: unknown } | null)?.candidates
    if (Array.isArray(candidates) && candidates.length > 0) {
      const parts = (candidates[0] as { content?: { parts?: unknown } })?.content?.parts
      if (Array.isArray(parts)) {
        const text = parts
          .map((p) => (typeof (p as { text?: unknown }).text === 'string'
            ? (p as { text: string }).text
            : ''))
          .join('')
          .trim()
        if (text.length > 0) return text
      }
    }
    throw new AiProviderError('Gemini returned an empty completion', 502, 'gemini')
  }
  throw new AiProviderError(
    `Gemini responded ${lastStatus}: ${lastDetail}`,
    lastStatus,
    'gemini',
  )
}

// ─── Provider-level chat (model list failover) ──────────────────────

export type ChatResult = {
  text: string
  provider: ChatProvider
  /** The model that actually answered (model-level transparency). */
  model: string
}

/**
 * Chat via ONE provider with its model list: try each model in order
 * (sticky last-working first). Model-level failures (404/410/400 gone,
 * per-model 429/5xx/timeout) advance to the provider's NEXT model;
 * provider-level failures (401 dead key, breaker open) abort the whole
 * provider immediately.
 */
async function chatViaProvider(
  def: ProviderDefinition,
  messages: ChatMessage[],
  opts: ChatOpts,
): Promise<ChatResult> {
  if (!def.apiKey) {
    throw new AiProviderError(`${def.label} is not configured (no API key)`, 503, def.id)
  }
  const models = orderedModels(def)
  let lastErr: unknown = null
  for (let i = 0; i < models.length; i++) {
    const model = models[i]
    try {
      const text = await attemptProvider(
        modelBreakerKey(def, model),
        () =>
          def.kind === 'gemini-native'
            ? geminiNativeChat(model, messages, opts)
            : openAiCompatChat(def, model, messages, opts),
        {
          capability: 'chat',
          provider: `${def.id}:${model}`,
          allowRetry: i === 0 && (opts.retry ?? true),
        },
      )
      lastWorkingModel.set(def.id, model)
      return { text, provider: def.id, model }
    } catch (err) {
      lastErr = err
      // Provider-level aborts: breaker open (skip instantly) or dead key.
      if (err instanceof ProviderUnavailableError) throw err
      if (err instanceof AiProviderError && err.status === 401) throw err
      // otherwise: model-level failure → try this provider's next model
    }
  }
  throw lastErr ?? new AiProviderError(`${def.label}: every model failed`, 502, def.id)
}

// ─── Chat with cross-provider fallback ──────────────────────────────

/**
 * Chat with the automatic provider chain:
 * groq → openrouter → nvidia → gemini → huggingface (each with its own
 * model-list failover). Throws AiProviderError(503) only when every
 * provider is down.
 */
export async function chatWithFallback(
  messages: ChatMessage[],
  opts: ChatOpts = {},
): Promise<ChatResult> {
  for (const def of CHAT_PROVIDERS) {
    if (!def.apiKey) continue // unconfigured provider — skip silently
    try {
      return await chatViaProvider(def, messages, opts)
    } catch {
      // safeLogAIError already recorded every model-level failure line
    }
  }
  throw new AiProviderError(
    'All AI providers are unavailable — please try again in a moment.',
    503,
    'all',
  )
}

// ─── Consensus (all models vote in parallel) ────────────────────────

export type ConsensusVote = {
  provider: ChatProvider
  model: string
  text: string
  ms: number
}

export type ConsensusResult = {
  text: string
  provider: ChatProvider
  model: string
  /** How many of the collected votes "agree" with the winner (incl. itself). */
  agreement: { agreed: number; total: number; ratio: number }
  /** Every collected vote (transparency — surfaced by /api/ai/status). */
  votes: ConsensusVote[]
  /** 'medoid' = multi-model agreement; 'single' = only one model answered. */
  strategy: 'medoid' | 'single'
  /** Providers that were invited but failed to vote (id → error class). */
  abstentions: { provider: ChatProvider; error: string }[]
}

/** English stopwords — tokens ignored when comparing two answers. */
const CONSENSUS_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'for', 'is', 'are', 'was',
  'on', 'with', 'at', 'by', 'from', 'as', 'it', 'its', 'be', 'this', 'that',
  'your', 'you', 'we', 'our', 'has', 'have', 'had', 'will', 'should', 'can',
])

/** Salient token set of an answer (lowercase, >2 chars, stopwords out). */
function salientTokens(text: string): Set<string> {
  const toks = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return new Set(toks.filter((t) => t.length > 2 && !CONSENSUS_STOPWORDS.has(t)))
}

/** Jaccard similarity between two token sets (0 when either is empty). */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  return inter / (a.size + b.size - inter)
}

/** A vote "agrees" with the winner at ≥0.34 token overlap. */
const CONSENSUS_AGREE_THRESHOLD = 0.34

/**
 * Ask every configured provider IN PARALLEL (its primary/sticky model),
 * then pick the MEDOID answer — the vote with the highest average
 * Jaccard similarity to all other votes. This is the consensus mode:
 * no single provider can silently steer the answer; a divergent or
 * hallucinating model is outvoted by its peers. Zero votes → the
 * sequential chain (chatWithFallback) is the safety net.
 */
export async function chatWithConsensus(
  messages: ChatMessage[],
  opts: ChatOpts = {},
): Promise<ConsensusResult> {
  const invited = CHAT_PROVIDERS.filter((def) => def.apiKey !== '')
  const consensusOpts: ChatOpts = {
    ...opts,
    timeoutMs: opts.timeoutMs ?? AI_CHAT_PRIMARY_TIMEOUT_MS,
    retry: false, // parallel fan-out — no per-model retries, deadline below
  }

  // Hard per-provider deadline: a straggling provider (cold reasoning model
  // chaining its second model after a first-model timeout) can never hold
  // the whole round hostage — it becomes an abstention instead.
  const deadline = Date.now() + AI_CONSENSUS_TIMEOUT_MS
  const withDeadline = async (def: ProviderDefinition): Promise<ConsensusVote> => {
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new AiProviderError('consensus deadline exhausted', 504, def.id)
    }
    return Promise.race([
      (async () => {
        const started = Date.now()
        const r = await chatViaProvider(def, messages, consensusOpts)
        return { ...r, ms: Date.now() - started } satisfies ConsensusVote
      })(),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new AiProviderError('consensus deadline', 504, def.id)),
          remaining,
        )
      }),
    ])
  }

  const settled = await Promise.allSettled(invited.map((def) => withDeadline(def)))

  const votes: ConsensusVote[] = []
  const abstentions: { provider: ChatProvider; error: string }[] = []
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') votes.push(s.value)
    else {
      const err = s.reason
      abstentions.push({
        provider: invited[i].id,
        error:
          err instanceof AiProviderError
            ? `${err.status}`
            : err instanceof ProviderUnavailableError
              ? 'breaker-open'
              : 'unknown',
      })
    }
  })

  // Zero votes → sequential chain as the safety net.
  if (votes.length === 0) {
    const chained = await chatWithFallback(messages, opts)
    return {
      ...chained,
      agreement: { agreed: 1, total: 1, ratio: 1 },
      votes: [{ ...chained, ms: -1 }],
      strategy: 'single',
      abstentions,
    }
  }

  if (votes.length === 1) {
    return {
      text: votes[0].text,
      provider: votes[0].provider,
      model: votes[0].model,
      agreement: { agreed: 1, total: 1, ratio: 1 },
      votes,
      strategy: 'single',
      abstentions,
    }
  }

  // Medoid selection: the vote with the highest average similarity.
  const tokenSets = votes.map((v) => salientTokens(v.text))
  let bestIdx = 0
  let bestScore = -1
  for (let i = 0; i < votes.length; i++) {
    let sum = 0
    for (let j = 0; j < votes.length; j++) {
      if (i === j) continue
      sum += jaccard(tokenSets[i], tokenSets[j])
    }
    const avg = sum / (votes.length - 1)
    if (avg > bestScore) {
      bestScore = avg
      bestIdx = i
    }
  }
  const winner = votes[bestIdx]
  const agreed = tokenSets.reduce(
    (n, ts, j) => (j === bestIdx ? n + 1 : jaccard(ts, tokenSets[bestIdx]) >= CONSENSUS_AGREE_THRESHOLD ? n + 1 : n),
    0,
  )

  return {
    text: winner.text,
    provider: winner.provider,
    model: winner.model,
    agreement: { agreed, total: votes.length, ratio: agreed / votes.length },
    votes,
    strategy: 'medoid',
    abstentions,
  }
}

// ─── Provider health (safe diagnostics — no secrets) ────────────────

export type AiProviderHealth = {
  id: ChatProvider
  label: string
  /** API key present in the environment. */
  configured: boolean
  /** Model list registered for this provider. */
  models: string[]
  /** The model that answered last (sticky) — null when none ever did. */
  lastWorkingModel: string | null
  /** Circuit-breaker snapshot per model (null when never attempted). */
  breakers: Record<string, BreakerStatus>
}

/** Safe per-provider health matrix for /api/ai/status (never keys). */
export function aiProviderHealth(): AiProviderHealth[] {
  const all = breakerStatus()
  return CHAT_PROVIDERS.map((def) => {
    const breakers: Record<string, BreakerStatus> = {}
    for (const model of def.models) {
      const key = modelBreakerKey(def, model)
      if (all[key]) breakers[key] = all[key]
    }
    return {
      id: def.id,
      label: def.label,
      configured: def.apiKey !== '',
      models: [...def.models],
      lastWorkingModel: lastWorkingModel.get(def.id) ?? null,
      breakers,
    }
  })
}

// ─── Embeddings (HF → router → alternate model → local fallback) ────

export type EmbedResult = { vectors: number[][]; provider: EmbedProvider }

/** Which provider actually produced the last embedTexts() call (diagnostics). */
let lastEmbedProvider: EmbedProvider = 'local'
export function embedProviderUsed(): EmbedProvider {
  return lastEmbedProvider
}

// In-memory LRU-ish cache: Map preserves insertion order, so eviction
// removes the oldest entry. Entries are invalidated by TTL (30 min).
type CacheEntry = { vectors: number[]; provider: EmbedProvider; ts: number }
const embedCache = new Map<string, CacheEntry>()

/** Simple deterministic string hash (FNV-1a 32-bit, hex + length). */
function hashText(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${(h >>> 0).toString(16)}:${text.length}`
}

function cacheSet(key: string, entry: CacheEntry): void {
  // re-insert to refresh recency for the LRU ordering
  embedCache.delete(key)
  embedCache.set(key, entry)
  while (embedCache.size > EMBED_CACHE_MAX_ENTRIES) {
    const oldest = embedCache.keys().next().value
    if (oldest === undefined) break
    embedCache.delete(oldest)
  }
}

/**
 * HuggingFace embedding candidates, in order:
 *  1. api-inference.huggingface.co (classic endpoint — the domain was
 *     retired during the inference-providers migration, may not resolve)
 *  2. router.huggingface.co/hf-inference .../all-MiniLM-L6-v2 (pinned
 *     model — the router serves sentence-transformers models as
 *     similarity-only pipelines, so raw embeddings may 400)
 *  3. router.huggingface.co/hf-inference .../BAAI/bge-small-en-v1.5
 *     (feature-extraction-capable fallback model, same HF key)
 */
const HF_EMBED_ENDPOINTS: ReadonlyArray<{
  url: string
  provider: string
  breakerKey: string
}> = [
  { url: HF_API_URL, provider: 'hf:minilm', breakerKey: 'embeddings:hf:minilm' },
  { url: HF_ROUTER_URL, provider: 'hf:router', breakerKey: 'embeddings:hf:router' },
  { url: HF_ALT_EMBED_URL, provider: 'hf:bge-small', breakerKey: 'embeddings:hf:bge-small' },
]
// Remember the last endpoint that worked so later calls skip dead ones.
let lastWorkingHfUrl: string | null = null

/** Call one HuggingFace inference endpoint for a batch of texts. */
async function hfEmbedBatch(url: string, texts: string[]): Promise<number[][]> {
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${HF_API_KEY}`,
      },
      body: JSON.stringify({
        inputs: texts,
        options: { wait_for_model: true },
      }),
    },
    AI_EMBED_TIMEOUT_MS,
  )
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new AiProviderError(
      `HuggingFace ${url.replace('https://', '').split('/')[2]} responded ${res.status}: ${body.slice(0, 160)}`,
      res.status,
      'huggingface',
    )
  }
  const data: unknown = await res.json().catch(() => null)
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new AiProviderError('HuggingFace returned an unexpected payload shape', 502, 'huggingface')
  }
  const vectors: number[][] = []
  for (const row of data) {
    if (
      !Array.isArray(row) ||
      row.length === 0 ||
      !row.every((n) => typeof n === 'number' && Number.isFinite(n))
    ) {
      throw new AiProviderError('HuggingFace returned non-numeric embedding rows', 502, 'huggingface')
    }
    vectors.push(row as number[])
  }
  return vectors
}

/** FNV-1a 32-bit token hash for the local hashed-bag-of-words embedding. */
function fnv1a(token: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < token.length; i++) {
    h ^= token.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Deterministic offline fallback embedding: UTF-8 token hashing into a
 * 256-dim signed bag-of-words vector, L2-normalized. Works fully offline
 * and keeps keyword-overlap search usable when every provider is down.
 */
export function localEmbed(text: string): number[] {
  const v = new Array<number>(256).fill(0)
  const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  for (const token of tokens) {
    const h = fnv1a(token)
    const bucket = h % 256
    const sign = (h >>> 16) & 1 ? 1 : -1
    v[bucket] += sign
  }
  let norm = 0
  for (const x of v) norm += x * x
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let i = 0; i < v.length; i++) v[i] = Number((v[i] / norm).toFixed(6))
  }
  return v
}

/**
 * Embed a batch of texts (ONE provider for the whole batch so cosine
 * similarity stays meaningful). Chain: pinned HF MiniLM endpoints →
 * HF alternate embedding model → local hashed-bow. Results are cached
 * per-text (30 min TTL, ~500 entries).
 */
export async function embedTexts(texts: string[]): Promise<EmbedResult> {
  if (texts.length === 0) return { vectors: [], provider: 'local' }

  // 1) Full-batch cache hit (all texts, same provider, fresh)?
  const now = Date.now()
  const keys = texts.map(hashText)
  let allHit = true
  let provider: EmbedProvider | null = null
  for (const key of keys) {
    const entry = embedCache.get(key)
    if (!entry || now - entry.ts > EMBED_CACHE_TTL_MS) {
      allHit = false
      break
    }
    if (provider === null) provider = entry.provider
    else if (entry.provider !== provider) {
      allHit = false
      break
    }
  }
  if (allHit && provider) {
    const vectors: number[][] = []
    let complete = true
    for (const key of keys) {
      const entry = embedCache.get(key)
      if (!entry || entry.provider !== provider) {
        complete = false
        break
      }
      vectors.push(entry.vectors)
    }
    if (complete) {
      // LRU recency touch
      for (const key of keys) {
        const entry = embedCache.get(key)
        if (entry) cacheSet(key, entry)
      }
      lastEmbedProvider = provider
      return { vectors, provider }
    }
    // an entry vanished mid-read → fall through to a fresh computation
  }

  // 2) Fresh computation — the whole batch MUST come from one provider.
  let vectors: number[][] | null = null
  let used: EmbedProvider = 'local'

  const ordered = lastWorkingHfUrl
    ? [
        ...HF_EMBED_ENDPOINTS.filter((e) => e.url === lastWorkingHfUrl),
        ...HF_EMBED_ENDPOINTS.filter((e) => e.url !== lastWorkingHfUrl),
      ]
    : HF_EMBED_ENDPOINTS
  for (let i = 0; i < ordered.length; i++) {
    const ep = ordered[i]
    try {
      // First attempted endpoint (the sticky primary) gets the one
      // transient retry; the rest fail straight to the next endpoint.
      vectors = await attemptProvider(ep.breakerKey, () => hfEmbedBatch(ep.url, texts), {
        capability: 'embeddings',
        provider: ep.provider,
        allowRetry: i === 0,
      })
      used = 'huggingface'
      lastWorkingHfUrl = ep.url
      break
    } catch {
      if (lastWorkingHfUrl === ep.url) lastWorkingHfUrl = null
      // safeLogAIError already recorded the one-line failure
    }
  }
  if (!vectors) {
    vectors = texts.map(localEmbed)
    used = 'local'
  }

  // 3) Store per-text entries.
  for (let i = 0; i < texts.length; i++) {
    cacheSet(keys[i], { vectors: vectors[i], provider: used, ts: now })
  }
  lastEmbedProvider = used
  return { vectors, provider: used }
}

// ─── Vector math (shared with routes) ───────────────────────────────

/** Cosine similarity (0 when dimensions/zero-norms make it undefined). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na <= 0 || nb <= 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
