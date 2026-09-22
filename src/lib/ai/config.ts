// ─── AI layer configuration (server-only) ───────────────────────────
// Keys are resolved env-first (.env / environment). NO hardcoded fallbacks:
// this file is public on GitHub — real keys live only in the local .env
// (untracked) or deployment secrets. Without keys the provider chain in
// providers.ts degrades gracefully (chat → z-ai-web-dev-sdk, search →
// deterministic local fallback) — the app never breaks.
// NEVER import this module from a client component — the keys must
// stay server-side only and are never echoed in API responses.

// Groq (OpenAI-compatible chat completions) — fast primary chat model.
export const GROQ_API_KEY = process.env.GROQ_API_KEY ?? ''
export const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions'
export const GROQ_MODEL = 'llama-3.3-70b-versatile'

// Google Gemini — secondary chat model (fallback when Groq is down).
export const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? ''
export const GEMINI_API_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
export const GEMINI_MODEL = 'gemini-2.5-flash'

// HuggingFace — sentence embeddings for semantic menu search.
export const HF_API_KEY = process.env.HF_API_KEY ?? ''
export const HF_API_URL =
  'https://api-inference.huggingface.co/models/sentence-transformers/all-MiniLM-L6-v2'
export const HF_ROUTER_URL =
  'https://router.huggingface.co/hf-inference/models/sentence-transformers/all-MiniLM-L6-v2'
export const HF_EMBED_MODEL = 'sentence-transformers/all-MiniLM-L6-v2'
export const HF_EMBED_DIM = 384

// HF feature-extraction-capable fallback model (same key). The router
// serves sentence-transformers/* models as similarity-only pipelines
// (no raw embeddings), so this alternate keeps real HF embeddings
// available when the pinned MiniLM endpoints cannot serve them.
export const HF_ALT_EMBED_URL =
  'https://router.huggingface.co/hf-inference/models/BAAI/bge-small-en-v1.5'

// Deterministic offline fallback embedding (hashed bag-of-words).
export const LOCAL_EMBED_DIM = 256

// Timeouts (AbortController) — chat has to answer fast, embeddings get
// a slightly shorter ceiling since the local fallback is instant.
export const AI_CHAT_TIMEOUT_MS = 25_000
export const AI_EMBED_TIMEOUT_MS = 20_000

// Embedding text cache (LRU-ish, in-process only).
export const EMBED_CACHE_MAX_ENTRIES = 500
export const EMBED_CACHE_TTL_MS = 30 * 60 * 1000
