// GET /api/ai/briefing — AI manager morning briefing grounded in the
// live business snapshot (admin only). 15-minute in-memory cache;
// ?refresh=1 forces recomputation. Response:
// { briefing: { text, provider, generatedAt, snapshot: { revenueToday,
// ordersToday, avgCheck, tipsToday, occupiedNow } }, cached }

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, errorResponse } from '@/lib/auth'
import { RESTAURANT_NAME } from '@/lib/constants'
import {
  chatWithFallback,
  AiProviderError,
  type ChatMessage,
} from '@/lib/ai/providers'
import { buildBusinessSnapshot, renderSnapshot } from '@/lib/ai/context'

const CACHE_TTL_MS = 15 * 60 * 1000

type BriefingPayload = {
  briefing: {
    text: string
    provider: string
    generatedAt: string
    snapshot: {
      revenueToday: number
      ordersToday: number
      avgCheck: number
      tipsToday: number
      occupiedNow: number
    }
  }
  cached: boolean
}

// Module-level in-memory cache (per server process).
let cachedBriefing: { payload: BriefingPayload; ts: number } | null = null

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['admin'])

    const refresh = new URL(req.url).searchParams.get('refresh') === '1'
    if (!refresh && cachedBriefing && Date.now() - cachedBriefing.ts < CACHE_TTL_MS) {
      return NextResponse.json({ ...cachedBriefing.payload, cached: true })
    }

    const snapshot = await buildBusinessSnapshot()
    const system = [
      `You are the AI morning-briefing writer for the manager of ${RESTAURANT_NAME}.`,
      'Write a daily manager briefing using ONLY the provided business data snapshot.',
      'Structure it exactly as:',
      '1) a two-sentence situation summary;',
      '2) 3-5 bullet insights, each starting with "- ", covering trends, slow movers, waiter performance, inventory risks, and the forecast vs recent days;',
      '3) a final line starting with "Recommendation:" giving ONE clear, actionable step for today (staffing, prep, or upsell).',
      'Maximum ~180 words. Use EGP amounts and Latin digits. No markdown headers or tables.',
      '',
      'LIVE BUSINESS DATA SNAPSHOT:',
      renderSnapshot(snapshot),
    ].join('\n')

    const messages: ChatMessage[] = [
      { role: 'user', content: "Generate today's manager briefing." },
    ]

    const started = Date.now()
    const { text, provider } = await chatWithFallback(messages, {
      system,
      temperature: 0.4,
      maxTokens: 700,
    })
    console.log(`[ai] briefing served by ${provider} in ${Date.now() - started}ms`)

    const payload: BriefingPayload = {
      briefing: {
        text,
        provider,
        generatedAt: new Date().toISOString(),
        snapshot: {
          revenueToday: snapshot.revenueToday,
          ordersToday: snapshot.ordersToday,
          avgCheck: snapshot.avgCheck,
          tipsToday: snapshot.tipsToday,
          occupiedNow: snapshot.tables.occupied,
        },
      },
      cached: false,
    }
    cachedBriefing = { payload, ts: Date.now() }

    return NextResponse.json(payload)
  } catch (err) {
    if (err instanceof AiProviderError) {
      return NextResponse.json(
        { error: 'The AI briefing service is temporarily unreachable — please try again in a moment.' },
        { status: 503 },
      )
    }
    return errorResponse(err)
  }
}
