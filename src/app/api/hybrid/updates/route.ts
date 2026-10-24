// /api/hybrid/updates — r61 cloud-update visibility for terminals.
//
// THE DESKTOP NOTIFICATION FEED. The hybrid engine already pulls cloud
// changes into the terminal database every 30 s — but until r61 that apply
// was INVISIBLE: an open POS kept its fetched menu, an open Menu admin kept
// its categories, and the owner had no idea the cloud had moved ("why did
// the menu change / why didn't it change here").
//
// This endpoint surfaces the pull cycle's bookkeeping:
//   · dataVersion       — monotonic counter; +1 per APPLIED remote event
//   · lastAppliedAt     — when the last applying cycle ran
//   · lastAppliedEntities — which entities changed (["Category","Product"] →
//                         "menu updated from cloud")
//   · lastPullAt / cloudReachable — connection context for the pill
//
// CloudUpdateWatcher polls this (20 s) and, on a version bump, toasts +
// invalidates every query cache — the "automatically update it" half of the
// owner's directive, with the toast as the "notification" half.
//
// Plane-aware: the CLOUD hub returns mode 'hub' (its own writes are local
// and already visible in the originating UI — nothing to notify) and the
// watcher stays silent there. Auth: any admin session OR a hybrid device
// (same dual door as /api/hybrid/live-health, without the settings gate —
// every logged-in staffer on a terminal deserves to see updates land).
import { NextRequest, NextResponse } from 'next/server'

import { errorResponse } from '@/lib/auth'
import { requireSessionOrDevice } from '@/lib/hybrid-auth'
import { getMany } from '@/lib/hybrid-sync/sync-state'
import {
  STATE_CLOUD_REACHABLE,
  STATE_DATA_VERSION,
  STATE_ENGINE_RUNNING_SINCE,
  STATE_LAST_APPLIED_AT,
  STATE_LAST_APPLIED_ENTITIES,
  STATE_LAST_PULL_AT,
  STATE_MENU_REIMPORT_AT,
} from '@/lib/hybrid-sync/constants'

export const dynamic = 'force-dynamic'

function parseEntities(raw: string | null): string[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String).slice(0, 12) : []
  } catch {
    return []
  }
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireSessionOrDevice(req)
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const isCloudDataPlane = !process.env.DATABASE_URL?.startsWith('file:')
    if (isCloudDataPlane) {
      // The hub: changes originate in this very UI (or arrive via /push and
      // are applied immediately) — there is no local pull stream to observe.
      return NextResponse.json({ mode: 'hub' as const, checkedAt: new Date().toISOString() })
    }

    // r61 note: ONE getMany (a single findMany) — NOT Promise.all around
    // per-key findUnique calls: concurrent findUnique storms on the libsql
    // adapter panicked Prisma's query compiler live in dev (CLIENT_CLOSED
    // afterward). The engine + health snapshot already use this pattern.
    const state = await getMany([
      STATE_DATA_VERSION,
      STATE_LAST_APPLIED_AT,
      STATE_LAST_APPLIED_ENTITIES,
      STATE_LAST_PULL_AT,
      STATE_CLOUD_REACHABLE,
      STATE_ENGINE_RUNNING_SINCE,
      STATE_MENU_REIMPORT_AT,
    ])

    return NextResponse.json({
      mode: 'terminal' as const,
      dataVersion: Number(state[STATE_DATA_VERSION] ?? 0) || 0,
      lastAppliedAt: state[STATE_LAST_APPLIED_AT],
      lastAppliedEntities: parseEntities(state[STATE_LAST_APPLIED_ENTITIES]),
      lastPullAt: state[STATE_LAST_PULL_AT],
      cloudReachable: state[STATE_CLOUD_REACHABLE],
      engineSince: state[STATE_ENGINE_RUNNING_SINCE],
      // r62: set when a menu.reimport audit event was applied — the watcher
      // toasts a dedicated "menu updated" notification from it (a reimport's
      // 400+ events otherwise land in the bulk-silent band).
      menuReimportAt: state[STATE_MENU_REIMPORT_AT] ?? null,
      checkedAt: new Date().toISOString(),
    })
  } catch (err) {
    return errorResponse(err)
  }
}
