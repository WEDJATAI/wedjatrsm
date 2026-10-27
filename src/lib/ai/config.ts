// ─── AI layer configuration (server-only) ───────────────────────────
// Keys are resolved env-first (.env / environment). NO hardcoded fallbacks:
// this file is public on GitHub — real keys live only in the local .env
// (untracked) or deployment secrets. Without a key the provider is
// reported 'unconfigured' and the chain in providers.ts skips it —
// the app never breaks.
// NEVER import this module from a client component — the keys must
// stay server-side only and are never echoed in API responses.
//
// P15 consensus architecture — five providers, each with its own MODEL
// LIST (verified live 2026-10-01; see worklog p15 for the probe matrix):
//   • groq       — OpenAI-compatible. Key currently DEAD (403) → the
//                  chain skips it; a fresh key re-arms it with zero
//                  code changes.
//   • openrouter — OpenAI-compatible, unlimited-credit key. Verified
//                  models: gemma-4-31b-it (fast), llama-3.3-70b,
//                  mimo-v2.6-flash. NOTE: google/gemini-* slugs are
//                  region-locked from this deployment's region — gemma
//                  is the Google-class model that serves here.
//   • nvidia     — OpenAI-compatible (integrate.api.nvidia.com).
//                  Verified: deepseek-v4.1-flash, nemotron-3-super-120b
//                  (reasoning model — answered via reasoning_content).
//   • gemini     — native generateContent. Key currently DEAD (401)
//                  → skipped until a fresh AIza/AQ key lands.
//   • huggingface— chat via the OpenAI-compatible router (136 models)
//                  + embeddings via the pinned MiniLM/bge endpoints.
// Every provider keeps ≥2 models: if ONE MODEL fails (404/410/400
// model-gone, per-model 429/5xx) the provider itself chooses its NEXT
// model; if the whole provider fails (auth/ network/ every model) the
// chain moves to the next provider. z.ai is fully REMOVED (p15).

// ── Groq (OpenAI-compatible chat completions) ──
export const GROQ_API_KEY = process.env.GROQ_API_KEY ?? ''
export const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions'
export const GROQ_MODELS = ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'] as const

// ── OpenRouter (OpenAI-compatible aggregator) ──
export const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? ''
export const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions'
export const OPENROUTER_MODELS = [
  'google/gemma-4-31b-it', // fastest verified (349ms)
  'meta-llama/llama-3.3-70b-instruct',
  'xiaomi/mimo-v2.6-flash',
] as const

// ── NVIDIA NIM (OpenAI-compatible) ──
export const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY ?? ''
export const NVIDIA_API_URL = 'https://integrate.api.nvidia.com/v1/chat/completions'
export const NVIDIA_MODELS = [
  'nvidia/nemotron-3.5-lightning-30b-a3b', // verified live 2.0s (reasoning model — 2026-10-03)
  'deepseek-ai/deepseek-v4.1-flash', // currently hangs 30s+ — kept as fallback; breaker skips fast
] as const

// ── Google Gemini (native generateContent) ──
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? ''
export const GEMINI_API_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
export const GEMINI_MODELS = ['gemini-2.5-flash'] as const

// ── HuggingFace ──
export const HF_API_KEY = process.env.HF_API_KEY ?? ''
// Chat (OpenAI-compatible router — 136 models available with this token)
export const HF_CHAT_API_URL = 'https://router.huggingface.co/v1/chat/completions'
export const HF_CHAT_MODELS = [
  'openai/gpt-oss-120b', // fastest verified (364ms)
  'meta-llama/Llama-3.3-70B-Instruct',
  'Qwen/Qwen3.8-27B',
  'deepseek-ai/DeepSeek-V4.1-Flash', // reasoning-capable (cross-provider twin of NVIDIA's)
] as const
// Embeddings (semantic menu search)
export const HF_API_URL =
  'https://api-inference.huggingface.co/models/sentence-transformers/all-MiniLM-L6-v2'
export const HF_ROUTER_URL =
  'https://router.huggingface.co/hf-inference/models/sentence-transformers/all-MiniLM-L6-v2'
export const HF_EMBED_MODEL = 'sentence-transformers/all-MiniLM-L6-v2'
export const HF_EMBED_DIM = 384
export const HF_ALT_EMBED_URL =
  'https://router.huggingface.co/hf-inference/models/BAAI/bge-small-en-v1.5'

// Deterministic offline fallback embedding (hashed bag-of-words).
export const LOCAL_EMBED_DIM = 256

// ── Timeouts (AbortController) ──
export const AI_CHAT_TIMEOUT_MS = 25_000
export const AI_CHAT_PRIMARY_TIMEOUT_MS = 15_000
export const AI_EMBED_TIMEOUT_MS = 20_000
/** Ceiling for a full consensus round (parallel fan-out + selection).
 * Stragglers past this deadline become abstentions — never block.
 * 25s: cold serverless instances can see a first-model timeout (15s)
 * + a second model landing at ~20s — the vote still counts. */
export const AI_CONSENSUS_TIMEOUT_MS = 25_000

// Embedding text cache (LRU-ish, in-process only).
export const EMBED_CACHE_MAX_ENTRIES = 500
export const EMBED_CACHE_TTL_MS = 30 * 60 * 1000
