// /api/hybrid/errors — R30 queue error inspector (admin).
//
// The last 50 outbound/inbound events parked as 'failed' or 'dead' — what
// the admin reads before hitting retry-failed (or fixing the root cause).
import { NextRequest, NextResponse } from 'next/server'

import { errorResponse, requireAuth } from '@/lib/auth'
import { db } from '@/lib/db'

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['settings'])
    const events = await db.hybridEvent.findMany({
      where: { status: { in: ['failed', 'dead'] } },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: {
        eventId: true,
        entity: true,
        entityId: true,
        operation: true,
        direction: true,
        status: true,
        attempts: true,
        lastError: true,
        updatedAt: true,
      },
    })
    return NextResponse.json({
      events: events.map((e) => ({
        eventId: e.eventId,
        entity: e.entity,
        entityId: e.entityId,
        operation: e.operation,
        direction: e.direction,
        status: e.status,
        attempts: e.attempts,
        lastError: e.lastError,
        updatedAt: e.updatedAt.toISOString(),
      })),
    })
  } catch (err) {
    return errorResponse(err)
  }
}
