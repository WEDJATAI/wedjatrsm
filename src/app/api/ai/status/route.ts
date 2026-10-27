// GET /api/ai/status — safe AI provider health matrix (admin only).
// Surfaces, per provider: configured (key present), registered model
// list, last-working model, per-model circuit-breaker state, and the
// embedding provider used last. NEVER keys, NEVER prompts/responses.
// This is the honest "what is the AI layer doing right now" view that
// powers ops triage and the honest-deployment evidence.

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth, errorResponse } from '@/lib/auth'
import { aiProviderHealth, embedProviderUsed, AI_CAPABILITY_CHAINS } from '@/lib/ai/providers'

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['admin'])

    const providers = aiProviderHealth().map((p) => ({
      id: p.id,
      label: p.label,
      configured: p.configured,
      models: p.models,
      lastWorkingModel: p.lastWorkingModel,
      // breaker state per model: closed = healthy, open = skipped fast,
      // half-open = probing recovery
      breakers: Object.fromEntries(
        Object.entries(p.breakers).map(([key, b]) => [
          key.replace(`chat:${p.id}:`, ''),
          {
            state: b.state,
            failures: b.failureCount,
            consecutiveFailures: b.consecutiveFailures,
            lastErrorClass: b.lastErrorClass,
            openUntil: b.openUntil,
          },
        ]),
      ),
    }))

    return NextResponse.json({
      providers,
      chain: {
        chat: AI_CAPABILITY_CHAINS.chat.entries.map((e) => ({
          provider: e.provider,
          label: e.label,
          models: e.models,
        })),
        consensus: AI_CAPABILITY_CHAINS.consensus.entries.map((e) => ({
          provider: e.provider,
          label: e.label,
          models: e.models,
        })),
      },
      embeddings: { lastProvider: embedProviderUsed() },
      generatedAt: new Date().toISOString(),
    })
  } catch (err) {
    return errorResponse(err)
  }
}
