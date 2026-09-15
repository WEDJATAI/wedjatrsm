// /api/sync/push — R15 push a sync bundle to the hosted master (admin/settings).
// POST { mode?: 'delta' | 'full' } (default delta). Builds the same bundle as
// /api/sync/export and POSTs it to {sync.targetUrl}/api/sync/import with the
// stored sync key (x-rsm-sync-key header, 20s timeout). The watermark is only
// advanced AFTER a successful push, so a failed push never silently drops
// rows — they stay pending for the next attempt. Returns { ok, target, summary }.

import { NextRequest, NextResponse } from 'next/server'

import { requireAuth, errorResponse, ApiError } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import type { SyncImportSummary } from '@/lib/types'
import { buildSyncBundle, markSyncExported, markSyncPushed, readSyncState, summarizeCounts } from '@/lib/sync'

export async function POST(req: NextRequest) {
  try {
    const user = await requireAuth(req, ['admin', 'settings'])

    let body: Record<string, unknown> = {}
    try {
      const parsed: unknown = await req.json()
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>
      }
    } catch {
      // fall through — invalid/empty JSON is treated as an empty body
    }
    const mode = body.mode === 'full' ? 'full' : 'delta'

    const state = await readSyncState()
    if (!state.targetUrl) {
      throw new ApiError(
        'No sync target configured — set the Cloud target URL in Settings → Sync Center first',
        400,
      )
    }

    const { bundle, exportedAt } = await buildSyncBundle(mode)
    const target = state.targetUrl.trim().replace(/\/+$/, '')

    let res: Response
    try {
      res = await fetch(`${target}/api/sync/import`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-rsm-sync-key': state.key },
        body: JSON.stringify(bundle),
        signal: AbortSignal.timeout(20_000),
      })
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'network error'
      throw new ApiError(`Push failed: could not reach ${target} (${reason})`, 502)
    }

    if (!res.ok) {
      const text = (await res.text().catch(() => '')).slice(0, 300)
      throw new ApiError(
        `Push rejected by ${target}: HTTP ${res.status}${text ? ` — ${text}` : ''}`,
        502,
      )
    }

    const json = (await res.json().catch(() => null)) as { summary?: SyncImportSummary } | null
    const summary = json?.summary ?? null

    // Only now is the delta consumed — a successful remote merge.
    if (mode === 'delta') await markSyncExported(exportedAt)
    await markSyncPushed(new Date())

    await logAudit({
      user,
      action: 'sync.push',
      entity: 'system',
      entityId: null,
      details:
        `Pushed ${mode} sync bundle to ${target} (${Object.values(bundle.counts).reduce((a, b) => a + b, 0)} rows): ` +
        `${summarizeCounts(bundle.counts)} — remote merge: ` +
        (summary
          ? `inserted ${Object.values(summary.inserted).reduce((a, b) => a + b, 0)}, ` +
            `updated ${Object.values(summary.updated).reduce((a, b) => a + b, 0)}, ` +
            `skipped ${Object.values(summary.skipped).reduce((a, b) => a + b, 0)}`
          : 'summary unavailable'),
    })

    return NextResponse.json({ ok: true, target, summary })
  } catch (err) {
    return errorResponse(err)
  }
}
