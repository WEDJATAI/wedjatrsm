// /api/hybrid/pull — R30 download endpoint (cloud → device).
//
// Device-authenticated. Returns the applied in-events this instance has
// received from OTHER devices (direction 'in', status 'applied', deviceId !=
// requester), ordered by the local autoincrement id (the cursor), newest
// last. The requester applies them with its own policy engine; duplicate
// deliveries are absorbed by eventId dedupe on every side.
//
// p20 harmony fix: on the CLOUD data plane (Postgres — this same codebase
// deployed on Vercel), the owner's own POS writes made THROUGH the cloud
// deployment emit outbox events (deviceId 'unbound' — emitOutboxEvent's
// marker when no local device identity exists) that no engine ever pushes:
// instrumentation starts the engine on file: SQLite only. Those origin
// writes are ALSO served here, interleaved into the same id-ordered stream,
// so pulling terminals receive cloud-originated business actions (check
// merges, defers, payments, table moves). Delivery stays exactly-once per
// terminal: each terminal persists its own cursor, and eventId dedupe on
// apply absorbs any duplicate. Local terminals (SQLite) keep the original
// behaviour — their own outbox is pushed by their engine, never pulled.
import { NextRequest, NextResponse } from 'next/server'
import type { Prisma } from '@prisma/client'

import { errorResponse } from '@/lib/auth'
import { requireDevice } from '@/lib/hybrid-auth'
import { db } from '@/lib/db'
import { HYBRID_PULL_MAX_LIMIT } from '@/lib/hybrid-sync/constants'

export async function GET(req: NextRequest) {
  try {
    const device = await requireDevice(req)
    if (!device) {
      return NextResponse.json({ error: 'Unauthorized: valid device credentials required' }, { status: 401 })
    }

    const params = new URL(req.url).searchParams
    const cursorRaw = Number(params.get('cursor') ?? '0')
    const limitRaw = Number(params.get('limit') ?? '100')
    const cursor = Number.isInteger(cursorRaw) && cursorRaw >= 0 ? cursorRaw : 0
    const limit = Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, HYBRID_PULL_MAX_LIMIT) : 100

    // stream shape: relay events from other terminals; the cloud data plane
    // additionally serves its own origin writes (see module header). No status
    // filter on the origin branch — those rows are only ever created by cloud
    // writes (born 'pending', never mutated: no engine runs here to settle
    // them; delivery is cursor-based, not status-based).
    const isCloudDataPlane = !process.env.DATABASE_URL?.startsWith('file:')
    const streamWhere: Prisma.HybridEventWhereInput = {
      deviceId: { not: device.deviceId },
      ...(isCloudDataPlane
        ? {
            OR: [
              { direction: 'in', status: 'applied' },
              { direction: 'out', deviceId: 'unbound' },
            ],
          }
        : { direction: 'in', status: 'applied' }),
    }

    const rows = await db.hybridEvent.findMany({
      where: { ...streamWhere, id: { gt: cursor } },
      orderBy: { id: 'asc' },
      take: limit,
      select: {
        id: true,
        eventId: true,
        deviceId: true,
        entity: true,
        entityId: true,
        operation: true,
        revision: true,
        payloadHash: true,
        payload: true,
        createdAt: true,
      },
    })

    const lastId = rows.length > 0 ? rows[rows.length - 1].id : cursor
    const remaining = await db.hybridEvent.count({
      where: { ...streamWhere, id: { gt: lastId } },
    })

    await db.hybridDevice.update({
      where: { id: device.id },
      data: { lastPullAt: new Date() },
    })

    return NextResponse.json({
      events: rows.map((row) => ({
        cursorId: row.id,
        eventId: row.eventId,
        deviceId: row.deviceId,
        entity: row.entity,
        entityId: row.entityId,
        operation: row.operation,
        revision: row.revision,
        payloadHash: row.payloadHash,
        payload: JSON.parse(row.payload) as unknown,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: lastId,
      remaining,
    })
  } catch (err) {
    return errorResponse(err)
  }
}
