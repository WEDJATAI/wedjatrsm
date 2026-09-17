// POST /api/ai/copilot — manager AI chat grounded in the live business
// snapshot (admin only). Body: { messages: [{ role: 'user'|'assistant',
// content }] } → { reply, provider }. Provider chain: Groq → Gemini;
// 503 with a friendly message when both are down.

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, errorResponse, ApiError } from '@/lib/auth'
import { RESTAURANT_NAME } from '@/lib/constants'
import {
  chatWithFallback,
  AiProviderError,
  type ChatMessage,
} from '@/lib/ai/providers'
import { buildBusinessSnapshot, renderSnapshot } from '@/lib/ai/context'

const MAX_MESSAGES = 10 // last N messages kept
const MAX_MESSAGE_CHARS = 2000
const MAX_TOTAL_CHARS = 12000 // total prompt guard over the kept history

export async function POST(req: NextRequest) {
  try {
    await requireAuth(req, ['admin'])

    // ── Body validation ────────────────────────────────────────────
    let body: Record<string, unknown>
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      throw new ApiError('Invalid JSON body', 400)
    }

    const raw: unknown = body.messages
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new ApiError('messages must be a non-empty array of { role, content }', 400)
    }
    const cleaned: ChatMessage[] = []
    for (const m of raw) {
      if (!m || typeof m !== 'object' || Array.isArray(m)) {
        throw new ApiError('each message must be an object { role, content }', 400)
      }
      const role = (m as { role?: unknown }).role
      const content = (m as { content?: unknown }).content
      if (role !== 'user' && role !== 'assistant') {
        throw new ApiError("message role must be 'user' or 'assistant'", 400)
      }
      if (typeof content !== 'string') {
        throw new ApiError('message content must be a string', 400)
      }
      const trimmed = content.trim()
      if (trimmed.length === 0) {
        throw new ApiError('message content cannot be empty', 400)
      }
      if (trimmed.length > MAX_MESSAGE_CHARS) {
        throw new ApiError(`message content exceeds ${MAX_MESSAGE_CHARS} characters`, 400)
      }
      cleaned.push({ role, content: trimmed })
    }
    if (!cleaned.some((m) => m.role === 'user')) {
      throw new ApiError('at least one user message is required', 400)
    }

    // Cap history: last 10 messages + total character guard.
    const history = cleaned.slice(-MAX_MESSAGES)
    const totalChars = history.reduce((s, m) => s + m.content.length, 0)
    if (totalChars > MAX_TOTAL_CHARS) {
      throw new ApiError(`conversation too long (max ${MAX_TOTAL_CHARS} characters)`, 400)
    }

    // ── Grounded system prompt with the live snapshot ──────────────
    const snapshot = await buildBusinessSnapshot()
    const system = [
      `You are Saffron Copilot, the restaurant manager's AI assistant for ${RESTAURANT_NAME}.`,
      'Answer ONLY from the provided business data snapshot + conversation.',
      'Be concise (max ~150 words unless asked), action-oriented, use EGP amounts, no markdown tables.',
      'If data is missing say so.',
      '',
      'LIVE BUSINESS DATA SNAPSHOT:',
      renderSnapshot(snapshot),
    ].join('\n')

    const started = Date.now()
    const { text, provider } = await chatWithFallback(history, {
      system,
      temperature: 0.3,
      maxTokens: 600,
    })
    console.log(`[ai] copilot served by ${provider} in ${Date.now() - started}ms`)

    return NextResponse.json({ reply: text, provider })
  } catch (err) {
    if (err instanceof AiProviderError) {
      // friendly 503 — never leak provider details or keys
      return NextResponse.json(
        { error: 'AI assistants are temporarily unreachable — please try again in a moment.' },
        { status: 503 },
      )
    }
    return errorResponse(err)
  }
}
