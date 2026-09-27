// /api/hybrid/pull — R30 download endpoint (cloud → device).
//
// Device-authenticated. Returns the applied in-events this instance has
// received from OTHER devices (direction 'in', status 'applied', deviceId !=
// requester), ordered by the local autoincrement id (the cursor), newest
// last. The requester applies them with its own policy engine; duplicate
// deliveries are absorbed by eventId dedupe on every side.
import { NextRequest, NextResponse } from 'next/server'

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

    const rows = await db.hybridEvent.findMany({
      where: {
        id: { gt: cursor },
        direction: 'in',
        status: 'applied',
        deviceId: { not: device.deviceId },
      },
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
      where: {
        id: { gt: lastId },
        direction: 'in',
        status: 'applied',
        deviceId: { not: device.deviceId },
      },
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
