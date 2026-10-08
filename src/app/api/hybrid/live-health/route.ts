// /api/hybrid/live-health — r43 compact live two-way sync health.
//
// The ONE endpoint the Launcher sync pill polls (every 30 s) on BOTH the
// cloud version (Vercel + Neon — the hub) and the desktop version (the
// full Windows install — a terminal with its own hybrid engine):
//
//   · terminal (SQLite plane): is the engine running, is the CLOUD
//     reachable, when did it last push/pull, how much is queued — the
//     desktop's live connection to the cloud.
//   · hub (Neon plane): is the datastore alive, how many devices are
//     enrolled/active, when did a device last contact the hub, how many
//     events flowed in the last hour — the cloud's live connection to its
//     terminals.
//
// Dual auth (same door as /api/hybrid/status): a settings session (the
// pill is shown to roles that can open Settings) OR an active hybrid
// device (the desktop agent's dashboard queries this for its health card).
import { NextRequest, NextResponse } from 'next/server'

import { errorResponse } from '@/lib/auth'
import { requireSessionOrDevice } from '@/lib/hybrid-auth'
import { buildHealthSnapshot } from '@/lib/hybrid-sync/health'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  try {
    const auth = await requireSessionOrDevice(req, ['settings'])
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const isCloudDataPlane = !process.env.DATABASE_URL?.startsWith('file:')

    if (!isCloudDataPlane) {
      // ── terminal (desktop / local instance with its own engine) ──
      const s = await buildHealthSnapshot()
      const healthy =
        s.local.dbOk &&
        s.engine === 'running' &&
        !s.paused &&
        s.cloud.reachable !== 'no' &&
        !s.restorePending
      return NextResponse.json({
        mode: 'terminal' as const,
        healthy,
        engine: s.engine,
        paused: s.paused,
        cloudReachable: s.cloud.reachable,
        cloudAuthFailed: s.cloud.authFailed,
        lastPushAt: s.lastPushAt,
        lastPullAt: s.lastPullAt,
        pendingUploads: s.counts.pendingUploads + s.counts.inflight,
        pendingDownloads: s.counts.pendingDownloads,
        failedOut: s.counts.failedOut,
        deviceName: s.device?.name ?? null,
        targetUrl: s.targetUrl,
        dbOk: s.local.dbOk,
        restorePending: s.restorePending,
        checkedAt: new Date().toISOString(),
      })
    }

    // ── hub (the cloud deployment) ──
    const { db } = await import('@/lib/db')
    let dbOk = true
    try {
      await db.$queryRaw`SELECT 1`
    } catch {
      dbOk = false
    }
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)
    const [activeDevices, lastSeenDevice, eventsLastHour, lastEvent] = await Promise.all([
      db.hybridDevice.count({ where: { status: 'active' } }).catch(() => 0),
      db.hybridDevice
        .findFirst({ where: { lastSeenAt: { not: null } }, orderBy: { lastSeenAt: 'desc' }, select: { lastSeenAt: true } })
        .catch(() => null),
      db.hybridEvent.count({ where: { createdAt: { gte: oneHourAgo } } }).catch(() => 0),
      db.hybridEvent.findFirst({ orderBy: { id: 'desc' }, select: { createdAt: true } }).catch(() => null),
    ])
    return NextResponse.json({
      mode: 'hub' as const,
      healthy: dbOk,
      dbOk,
      activeDevices,
      lastDeviceContactAt: lastSeenDevice?.lastSeenAt?.toISOString() ?? null,
      eventsLastHour,
      lastEventAt: lastEvent?.createdAt?.toISOString() ?? null,
      checkedAt: new Date().toISOString(),
    })
  } catch (err) {
    return errorResponse(err)
  }
}
