// ─── AI providers (server-only) ─────────────────────────────────────
// Provider-agnostic multi-model layer:
//   • chat:    Groq (llama-3.3-70b) → Gemini (2.5-flash) → platform
//              z-ai-web-dev-sdk (backend-only, per project convention)
//   • search:  HuggingFace MiniLM (pinned endpoints) → HF bge-small
//              alternate model → deterministic local hashed-bag-of-words
//              fallback (never fails, keeps search usable offline)
// All external requests are plain `fetch` with AbortController timeouts —
// no extra packages. Keys come from ./config (env ?? constant) and never
// leave the server.

import {
  GROQ_API_KEY,
  GROQ_API_URL,
  GROQ_MODEL,
  GEMINI_API_KEY,
  GEMINI_API_URL,
  HF_API_KEY,
  HF_API_URL,
  HF_ROUTER_URL,
  HF_ALT_EMBED_URL,
  AI_CHAT_TIMEOUT_MS,
  AI_EMBED_TIMEOUT_MS,
  EMBED_CACHE_MAX_ENTRIES,
  EMBED_CACHE_TTL_MS,
} from './config'

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
}

export type ChatProvider = 'groq' | 'gemini' | 'zai'
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

/** Promise.race timeout for SDK calls that don't take an AbortSignal. */
async function withTimeout<T>(p: Promise<T>, ms: number, provider: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new AiProviderError(`${provider} timed out after ${ms}ms`, 504, provider)),
          ms,
        )
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
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

// ─── Groq (OpenAI-compatible) ───────────────────────────────────────

/** Chat completion via Groq's OpenAI-compatible endpoint. Returns the assistant text. */
export async function groqChat(messages: ChatMessage[], opts: ChatOpts = {}): Promise<string> {
  const payload: Record<string, unknown> = {
    model: GROQ_MODEL,
    messages: opts.system
      ? [{ role: 'system', content: opts.system }, ...messages]
      : messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.maxTokens ?? 700,
  }

  let res: Response
  try {
    res = await fetchWithTimeout(
      GROQ_API_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify(payload),
      },
      AI_CHAT_TIMEOUT_MS,
    )
  } catch (err) {
    throw new AiProviderError(
      `Groq request failed (${briefError(err)})`,
      statusFromError(err),
      'groq',
    )
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new AiProviderError(
      `Groq responded ${res.status}: ${body.slice(0, 200)}`,
      res.status,
      'groq',
    )
  }

  const data: unknown = await res.json().catch(() => null)
  const choices = (data as { choices?: unknown } | null)?.choices
  if (Array.isArray(choices) && choices.length > 0) {
    const content = (choices[0] as { message?: { content?: unknown } })?.message?.content
    if (typeof content === 'string' && content.trim().length > 0) return content.trim()
  }
  throw new AiProviderError('Groq returned an empty completion', 502, 'groq')
}

// ─── Gemini ─────────────────────────────────────────────────────────

/** Single-turn chat via Gemini generateContent (system instruction + prompt). */
export async function geminiChat(
  prompt: string,
  system: string,
  opts: ChatOpts = {},
): Promise<string> {
  const payload: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    systemInstruction: { parts: [{ text: system }] },
    generationConfig: {
      temperature: opts.temperature ?? 0.3,
      maxOutputTokens: opts.maxTokens ?? 700,
    },
  }

  // The provided key format is unusual (not AIza…). Try the x-goog-api-key
  // header first, then the ?key= query-param variant on 401/403.
  const attempts: { url: string; headers: Record<string, string> }[] = [
    { url: GEMINI_API_URL, headers: { 'x-goog-api-key': GEMINI_API_KEY } },
    { url: `${GEMINI_API_URL}?key=${encodeURIComponent(GEMINI_API_KEY)}`, headers: {} },
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
        AI_CHAT_TIMEOUT_MS,
      )
    } catch (err) {
      lastStatus = statusFromError(err)
      lastDetail = briefError(err)
      continue
    }
    if (!res.ok) {
      lastStatus = res.status
      lastDetail = (await res.text().catch(() => '')).slice(0, 200)
      // 401/403 → try the query-param variant next
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

// ─── Platform z-ai SDK (last-resort chat fallback, backend only) ────

type ZaiChatCompletion = {
  choices?: { message?: { content?: unknown } }[]
}
type ZaiSdk = {
  chat: { completions: { create: (args: unknown) => Promise<ZaiChatCompletion> } }
}

let zaiInstance: ZaiSdk | null = null

/** Lazily create (and reuse) the z-ai SDK client — backend only. */
async function getZai(): Promise<ZaiSdk> {
  if (zaiInstance) return zaiInstance
  const mod = (await import('z-ai-web-dev-sdk')) as {
    default: { create: () => Promise<ZaiSdk> }
  }
  zaiInstance = await mod.default.create()
  return zaiInstance
}

/**
 * Chat via the platform's z-ai-web-dev-sdk (the project's built-in LLM
 * service). The SDK convention sends the system prompt as the leading
 * 'assistant' message.
 */
export async function zaiChat(messages: ChatMessage[], opts: ChatOpts = {}): Promise<string> {
  const zai = await getZai()
  const payload = [
    ...(opts.system
      ? [{ role: 'assistant', content: opts.system }]
      : []),
    ...messages,
  ]
  const completion = await withTimeout(
    zai.chat.completions.create({
      messages: payload,
      thinking: { type: 'disabled' },
    }),
    AI_CHAT_TIMEOUT_MS,
    'zai',
  )
  const content = completion.choices?.[0]?.message?.content
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new AiProviderError('z-ai returned an empty completion', 502, 'zai')
  }
  return content.trim()
}

// ─── Chat with provider fallback ────────────────────────────────────

export type ChatResult = { text: string; provider: ChatProvider }

/**
 * Chat with an automatic provider chain: Groq → Gemini → z-ai (platform
 * SDK). Throws AiProviderError(503) only when every provider is down.
 */
export async function chatWithFallback(
  messages: ChatMessage[],
  opts: ChatOpts = {},
): Promise<ChatResult> {
  // 1) Groq (fast primary — user-provided key)
  try {
    const text = await groqChat(messages, opts)
    return { text, provider: 'groq' }
  } catch (err) {
    console.warn('[ai] groq failed → falling back to gemini:', briefError(err))
  }

  // 2) Gemini (single-turn: flatten the conversation into one prompt)
  try {
    const transcript = messages
      .map((m) => `${m.role === 'user' ? 'Manager' : 'Assistant'}: ${m.content}`)
      .join('\n\n')
    const text = await geminiChat(
      transcript,
      opts.system ?? 'You are a helpful restaurant management assistant.',
      opts,
    )
    return { text, provider: 'gemini' }
  } catch (err) {
    console.warn('[ai] gemini failed → falling back to z-ai sdk:', briefError(err))
  }

  // 3) Platform z-ai SDK (backend-only built-in LLM service)
  try {
    const text = await zaiChat(messages, opts)
    return { text, provider: 'zai' }
  } catch (err) {
    console.warn('[ai] z-ai failed too:', briefError(err))
  }

  throw new AiProviderError(
    'All AI providers are unavailable — please try again in a moment.',
    503,
    'all',
  )
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
const HF_EMBED_URLS = [HF_API_URL, HF_ROUTER_URL, HF_ALT_EMBED_URL]
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

  const orderedUrls = lastWorkingHfUrl
    ? [lastWorkingHfUrl, ...HF_EMBED_URLS.filter((u) => u !== lastWorkingHfUrl)]
    : HF_EMBED_URLS
  for (const url of orderedUrls) {
    try {
      vectors = await hfEmbedBatch(url, texts)
      used = 'huggingface'
      lastWorkingHfUrl = url
      break
    } catch (err) {
      if (lastWorkingHfUrl === url) lastWorkingHfUrl = null
      console.warn(`[ai] hf endpoint failed (${url}):`, briefError(err))
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
