// /api/sync/import — R15 receiving endpoint for sync bundles.
//
// Auth is deliberately dual:
//  - an admin/settings session (the Sync Center UI "Import bundle" path), OR
//  - a machine header `x-rsm-sync-key` matching the stored sync key,
//    compared with crypto.timingSafeEqual (constant time) — this is how a
//    Windows instance pushing to its hosted master authenticates.
//
// Body = rsm-sync/1 SyncBundle. Merge semantics (honest one-way merge):
//  - upsert by id in FK order: customers → orders → orderItems → payments →
//    attendance → cashEntries → inventoryTransactions → reservations → auditLogs
//  - per-row try/catch: a row whose FK parent is missing or that fails a
//    constraint is SKIPPED — it never aborts the whole import
//  - nothing is ever deleted; the incoming row wins (last-writer-wins by
//    bundle generation time)
//  - importing a bundle exported from THIS SAME database is a clean no-op
//    (every row updates itself: 0 inserted, 0 skipped)
//
// Returns { summary } with per-table inserted/updated/skipped counts.

import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'

import { getSessionUser, errorResponse, ApiError } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { SYNC_FORMAT, importSyncBundle, readSyncState, summarizeCounts, type SyncBundleInput } from '@/lib/sync'

/** Constant-time key comparison (length mismatch fails fast — same tradeoff
 *  as the delivery webhook route, which cannot hide key length anyway). */
function keysMatch(provided: string, stored: string): boolean {
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(stored, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export async function POST(req: NextRequest) {
  try {
    // ── dual auth: session OR sync key ──
    let actor: { userId: number; name: string; personId: number | null; personName: string | null } | null = null
    const session = await getSessionUser(req)
    if (session) {
      const allowed = session.role === 'admin' || session.permissions.includes('settings')
      if (!allowed) throw new ApiError('Forbidden: insufficient role', 403)
      actor = { userId: session.userId, name: session.name, personId: session.personId, personName: session.personName }
    } else {
      const provided = (req.headers.get('x-rsm-sync-key') ?? '').trim()
      const state = await readSyncState()
      if (!provided || !keysMatch(provided, state.key)) {
        throw new ApiError('Unauthorized: an admin session or a valid x-rsm-sync-key is required', 401)
      }
      // audit_logs.user_id carries no FK (denormalized snapshot column), so a
      // synthetic id is safe — the human-readable name is what matters.
      actor = { userId: 0, name: 'system (sync)', personId: null, personName: null }
    }

    const body: SyncBundleInput = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })
    if (!body || typeof body !== 'object' || body.format !== SYNC_FORMAT) {
      throw new ApiError(`Unsupported bundle format — expected ${SYNC_FORMAT}`, 400)
    }

    const summary = await importSyncBundle(body)

    const inserted = Object.values(summary.inserted).reduce((a, b) => a + b, 0)
    const updated = Object.values(summary.updated).reduce((a, b) => a + b, 0)
    const skipped = Object.values(summary.skipped).reduce((a, b) => a + b, 0)
    await logAudit({
      user: actor,
      action: 'sync.import',
      entity: 'system',
      entityId: null,
      details:
        `Imported sync bundle from ${String(body.source ?? 'unknown')} ` +
        `(${String(body.mode ?? 'delta')}, ${String(body.generatedAt ?? '?')}): ` +
        `inserted ${inserted}${inserted > 0 ? ` (${summarizeCounts(summary.inserted)})` : ''}, ` +
        `updated ${updated}, skipped ${skipped}`,
    })

    return NextResponse.json({ summary })
  } catch (err) {
    return errorResponse(err)
  }
}
