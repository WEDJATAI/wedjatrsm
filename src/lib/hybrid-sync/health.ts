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

/** Per-device row for the hub panel (the cloud's connected terminals). */
export type HubDeviceRow = {
  name: string
  platform: string
  status: string
  lastSeenAt: string | null
  lastPullAt: string | null
}

/** Hub-side metrics — only computed on the cloud data plane (the Vercel +
 *  Neon deployment). The hub has no local engine, no target URL and no
 *  upload queue: cloud-origin writes are the cursor-based delivery stream
 *  every terminal pulls. Rendering these instead of the terminal-shaped
 *  fields is what keeps the cloud Settings page from permanently showing a
 *  misleading "N changes waiting to sync" banner (the r59 fix). */
export type HubHealth = {
  activeDevices: number
  lastDeviceContactAt: string | null
  eventsLastHour: number
  lastEventAt: string | null
  /** total cloud-origin events in the delivery stream (served, not queued) */
  deliveryStream: number
  /** the most recently active terminals — the card's device list */
  devices: HubDeviceRow[]
}

export type HybridHealthSnapshot = {
  version: string
  /** 'hub' on the cloud data plane, 'terminal' on a desktop/local install. */
  mode: 'terminal' | 'hub'
  /** hub metrics (null on the terminal plane) */
  hub: HubHealth | null
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
  // r59: the CLOUD data plane (Neon/Postgres — no file: URL) is the HUB. Its
  // 'out'/'pending' rows are cloud-origin writes that no engine ever settles
  // — delivery is cursor-based (terminals pull them), so counting them as
  // "pending uploads" made the cloud Settings page show a permanently
  // growing "waiting to sync" banner. On the hub we compute hub metrics
  // instead and neutralize the terminal queue counts.
  const isCloudDataPlane = !process.env.DATABASE_URL?.startsWith('file:')

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

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
  const [targetUrl, device, counts, conflicts, pendingDownloads, hubMetrics] = await Promise.all([
    readHybridTargetUrl(),
    getLocalDevice(),
    db.hybridEvent.groupBy({
      by: ['direction', 'status'],
      _count: { _all: true },
      where: { direction: { in: ['out', 'in'] } },
    }),
    db.hybridConflict.count(),
    Number(state[STATE_PULL_REMAINING] ?? 0),
    // hub metrics — only awaited (cheap count) on the cloud plane
    isCloudDataPlane
      ? Promise.all([
          db.hybridDevice.count({ where: { status: 'active' } }).catch(() => 0),
          db.hybridDevice
            .findFirst({ where: { lastSeenAt: { not: null } }, orderBy: { lastSeenAt: 'desc' }, select: { lastSeenAt: true } })
            .catch(() => null),
          db.hybridEvent.count({ where: { createdAt: { gte: oneHourAgo } } }).catch(() => 0),
          db.hybridEvent.findFirst({ orderBy: { id: 'desc' }, select: { createdAt: true } }).catch(() => null),
          db.hybridEvent.count({ where: { direction: 'out', deviceId: 'unbound' } }).catch(() => 0),
          db.hybridDevice
            .findMany({
              orderBy: [{ lastSeenAt: { sort: 'desc', nulls: 'last' } }],
              take: 8,
              select: { name: true, platform: true, status: true, lastSeenAt: true, lastPullAt: true },
            })
            .catch(() => [] as Array<{ name: string; platform: string; status: string; lastSeenAt: Date | null; lastPullAt: Date | null }>),
        ])
      : null,
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

  const hub: HubHealth | null =
    isCloudDataPlane && hubMetrics
      ? {
          activeDevices: Number(hubMetrics[0] ?? 0),
          lastDeviceContactAt: (hubMetrics[1] as { lastSeenAt: Date | null } | null)?.lastSeenAt?.toISOString() ?? null,
          eventsLastHour: Number(hubMetrics[2] ?? 0),
          lastEventAt: (hubMetrics[3] as { createdAt: Date | null } | null)?.createdAt?.toISOString() ?? null,
          deliveryStream: Number(hubMetrics[4] ?? 0),
          devices: (hubMetrics[5] as Array<{ name: string; platform: string; status: string; lastSeenAt: Date | null; lastPullAt: Date | null }>).map(
            (d) => ({
              name: d.name,
              platform: d.platform,
              status: d.status,
              lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
              lastPullAt: d.lastPullAt?.toISOString() ?? null,
            }),
          ),
        }
      : null

  return {
    version: HYBRID_FORMAT,
    mode: isCloudDataPlane ? 'hub' : 'terminal',
    hub,
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
      // On the HUB the 'out'/'pending' pool is the cursor-based delivery
      // stream (cloud-origin writes), NOT an upload queue — reported as
      // hub.deliveryStream instead so the UI never counts it as "waiting".
      pendingUploads: isCloudDataPlane ? 0 : countOf('out', 'pending'),
      inflight: isCloudDataPlane ? 0 : countOf('out', 'inflight'),
      failedOut: isCloudDataPlane ? 0 : countOf('out', 'failed'),
      deadOut: isCloudDataPlane ? 0 : countOf('out', 'dead'),
      failedIn: isCloudDataPlane ? 0 : countOf('in', 'failed'),
      conflicts,
      pendingDownloads: isCloudDataPlane ? 0 : Number.isFinite(pendingDownloads) ? pendingDownloads : 0,
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
