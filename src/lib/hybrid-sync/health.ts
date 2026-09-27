/**
 * R30 hybrid sync — health snapshot for the admin UI.
 *
 * One read-only call answers everything the Sync Center status pill needs:
 * engine state, pause flag, queue depths, last contact times, cloud
 * reachability, database liveness, staged-restore marker. Secrets are never
 * included — the target URL is masked to host+path, the device id to its
 * first 8 characters.
 */
import { db } from '@/lib/db'
import { readHybridTargetUrl } from './push'
import { getLocalDevice } from './device-identity'
import {
  HYBRID_FORMAT,
  STATE_CLOUD_AUTH_FAILED,
  STATE_CLOUD_LAST_CHECKED,
  STATE_CLOUD_REACHABLE,
  STATE_LAST_PULL_AT,
  STATE_LAST_PUSH_AT,
  STATE_LAST_RECONCILE_AT,
  STATE_PULL_REMAINING,
  STATE_RESTORE_PENDING,
  STATE_SYNC_PAUSED,
} from './constants'
import { getMany } from './sync-state'
import { isEngineRunning } from './hybrid-engine'

export type HybridHealthSnapshot = {
  version: string
  engine: 'running' | 'stopped'
  paused: boolean
  targetUrl: string | null
  device: { deviceId: string; name: string; status: string } | null
  counts: {
    pendingUploads: number
    inflight: number
    failedOut: number
    deadOut: number
    failedIn: number
    conflicts: number
    pendingDownloads: number
  }
  lastPushAt: string | null
  lastPullAt: string | null
  lastReconcileAt: string | null
  cloud: {
    reachable: 'yes' | 'no' | 'unknown'
    lastCheckedAt: string | null
    authFailed: boolean
  }
  local: { dbOk: boolean }
  restorePending: string | null
}

/** host+path only — never the full URL (credentials must never leak, even
 * though this app's URLs carry none, the guard stays). */
function maskTargetUrl(url: string): string | null {
  if (!url) return null
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`
  } catch {
    return 'invalid-url'
  }
}

export async function buildHealthSnapshot(): Promise<HybridHealthSnapshot> {
  const state = await getMany([
    STATE_SYNC_PAUSED,
    STATE_LAST_PUSH_AT,
    STATE_LAST_PULL_AT,
    STATE_LAST_RECONCILE_AT,
    STATE_CLOUD_REACHABLE,
    STATE_CLOUD_LAST_CHECKED,
    STATE_CLOUD_AUTH_FAILED,
    STATE_PULL_REMAINING,
    STATE_RESTORE_PENDING,
  ])

  const [targetUrl, device, counts, conflicts, pendingDownloads] = await Promise.all([
    readHybridTargetUrl(),
    getLocalDevice(),
    db.hybridEvent.groupBy({
      by: ['direction', 'status'],
      _count: { _all: true },
      where: { direction: { in: ['out', 'in'] } },
    }),
    db.hybridConflict.count(),
    Number(state[STATE_PULL_REMAINING] ?? 0),
  ])

  const countOf = (direction: string, status: string): number =>
    counts.find((c) => c.direction === direction && c.status === status)?._count._all ?? 0

  let dbOk = true
  try {
    await db.$queryRaw`SELECT 1`
  } catch {
    dbOk = false
  }

  const reachableRaw = state[STATE_CLOUD_REACHABLE]

  return {
    version: HYBRID_FORMAT,
    engine: isEngineRunning() ? 'running' : 'stopped',
    paused: state[STATE_SYNC_PAUSED] === '1',
    targetUrl: maskTargetUrl(targetUrl),
    device: device
      ? {
          deviceId: `${device.deviceId.slice(0, 8)}…`,
          name: device.name,
          status: device.status,
        }
      : null,
    counts: {
      pendingUploads: countOf('out', 'pending'),
      inflight: countOf('out', 'inflight'),
      failedOut: countOf('out', 'failed'),
      deadOut: countOf('out', 'dead'),
      failedIn: countOf('in', 'failed'),
      conflicts,
      pendingDownloads: Number.isFinite(pendingDownloads) ? pendingDownloads : 0,
    },
    lastPushAt: state[STATE_LAST_PUSH_AT] ?? null,
    lastPullAt: state[STATE_LAST_PULL_AT] ?? null,
    lastReconcileAt: state[STATE_LAST_RECONCILE_AT] ?? null,
    cloud: {
      reachable: reachableRaw === 'yes' || reachableRaw === 'no' ? reachableRaw : 'unknown',
      lastCheckedAt: state[STATE_CLOUD_LAST_CHECKED] ?? null,
      authFailed: state[STATE_CLOUD_AUTH_FAILED] === '1',
    },
    local: { dbOk },
    restorePending: state[STATE_RESTORE_PENDING] ?? null,
  }
}
