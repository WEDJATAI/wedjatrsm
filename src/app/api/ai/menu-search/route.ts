// POST /api/ai/menu-search — semantic product search for POS staff
// (any authenticated user). Body: { query } (2-120 chars) →
// { results: [{ productId, name, nameAr, price, score }], provider }
// provider is 'huggingface' (real embeddings — semantic mode) or
// 'local' (offline hashed-bow — keyword mode) so the UI can label it.
//
// Arabic-script-only queries use keyword mode directly: the English-only
// HF fallback model cannot rank Arabic semantically (noise ~0.55-0.65
// for everything), while the local hashed-bow matches Arabic tokens
// exactly (e.g. the product's own nameAr).

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, errorResponse, ApiError } from '@/lib/auth'
import {
  embedTexts,
  cosineSimilarity,
  localEmbed,
  type EmbedProvider,
} from '@/lib/ai/providers'

const MIN_QUERY_CHARS = 2
const MAX_QUERY_CHARS = 120
const MAX_RESULTS = 8
const HF_SCORE_THRESHOLD = 0.15 // real embedding cosine similarities
const LOCAL_SCORE_THRESHOLD = 0.05 // hashed-bow distribution is flatter
const PRODUCT_CACHE_TTL_MS = 30 * 60 * 1000

const ARABIC_SCRIPT_RE = /[\u0600-\u06FF]/
const LATIN_LETTER_RE = /[a-z]/i

type MenuProductRow = {
  id: number
  name: string
  nameAr: string | null
  price: number
  text: string // embedding text: name · nameAr · category
}

// In-memory product-embedding cache keyed by the product-list
// fingerprint (products lack updatedAt → count + max id). Entries hold
// the provider so query/product vectors never mix dimensions.
const productCache = new Map<
  string,
  { vectors: number[][]; provider: EmbedProvider; ts: number; dims: number }
>()

export async function POST(req: NextRequest) {
  try {
    await requireAuth(req) // any authenticated staff member

    // ── Body validation ────────────────────────────────────────────
    let body: Record<string, unknown>
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      throw new ApiError('Invalid JSON body', 400)
    }
    const rawQuery: unknown = body.query
    if (typeof rawQuery !== 'string') {
      throw new ApiError('query must be a string', 400)
    }
    const query = rawQuery.trim()
    if (query.length < MIN_QUERY_CHARS || query.length > MAX_QUERY_CHARS) {
      throw new ApiError(
        `query must be between ${MIN_QUERY_CHARS} and ${MAX_QUERY_CHARS} characters`,
        400,
      )
    }

    // ── Load active products (embedding text: name · nameAr · category;
    //    the Product model has no description field — see worklog) ──
    const rows = await db.product.findMany({
      where: { active: true, isSellable: true },
      select: {
        id: true,
        name: true,
        nameAr: true,
        price: true,
        category: { select: { name: true } },
      },
      orderBy: { id: 'asc' },
    })
    if (rows.length === 0) {
      return NextResponse.json({ results: [], provider: 'local' })
    }
    const products: MenuProductRow[] = rows.map((p) => ({
      id: p.id,
      name: p.name,
      nameAr: p.nameAr,
      price: p.price,
      text: [p.name, p.nameAr, p.category?.name].filter(Boolean).join(' · '),
    }))

    // ── Embeddings ─────────────────────────────────────────────────
    let queryVector: number[]
    let provider: EmbedProvider
    let productVectors: number[][]

    // Arabic-script-only query → keyword mode (exact token matching).
    const arabicOnly = ARABIC_SCRIPT_RE.test(query) && !LATIN_LETTER_RE.test(query)
    if (arabicOnly) {
      queryVector = localEmbed(query)
      productVectors = products.map((p) => localEmbed(p.text))
      provider = 'local'
    } else {
      let maxId = 0
      for (const p of products) if (p.id > maxId) maxId = p.id
      const fingerprint = `menu-v1:${products.length}:${maxId}`

      const cached = productCache.get(fingerprint)
      const cacheFresh =
        cached !== undefined && Date.now() - cached.ts < PRODUCT_CACHE_TTL_MS

      if (cacheFresh) {
        // Embed only the query; if its provider (or dimension) disagrees
        // with the cached product vectors, recompute the whole batch so
        // every vector comes from the same provider run.
        const q = await embedTexts([query])
        if (q.provider === cached.provider && q.vectors[0]?.length === cached.dims) {
          queryVector = q.vectors[0]
          provider = q.provider
          productVectors = cached.vectors
        } else {
          const all = await embedTexts([query, ...products.map((p) => p.text)])
          queryVector = all.vectors[0]
          provider = all.provider
          productVectors = all.vectors.slice(1)
          productCache.set(fingerprint, {
            vectors: productVectors,
            provider,
            ts: Date.now(),
            dims: productVectors[0]?.length ?? 0,
          })
        }
      } else {
        // One call for query + all product strings (consistent provider).
        const all = await embedTexts([query, ...products.map((p) => p.text)])
        queryVector = all.vectors[0]
        provider = all.provider
        productVectors = all.vectors.slice(1)
        productCache.set(fingerprint, {
          vectors: productVectors,
          provider,
          ts: Date.now(),
          dims: productVectors[0]?.length ?? 0,
        })
      }
    }

    // ── Cosine ranking ─────────────────────────────────────────────
    const threshold = provider === 'huggingface' ? HF_SCORE_THRESHOLD : LOCAL_SCORE_THRESHOLD
    const scored = products
      .map((p, i) => ({
        product: p,
        score: Number(cosineSimilarity(queryVector, productVectors[i] ?? []).toFixed(4)),
      }))
      .filter((s) => s.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS)

    return NextResponse.json({
      results: scored.map((s) => ({
        productId: s.product.id,
        name: s.product.name,
        nameAr: s.product.nameAr,
        price: s.product.price,
        score: s.score,
      })),
      provider,
    })
  } catch (err) {
    return errorResponse(err)
  }
}
