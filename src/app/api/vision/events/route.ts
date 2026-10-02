// /api/vision/events — event log (GET, perm 'vision') + the EDGE INGEST
// endpoint (POST). POST auth: a session with the 'vision' permission OR a
// valid ingest key (Authorization: Bearer <key> or x-vision-key: <key>).

import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'
import { VISION_INGEST_RATE_LIMIT } from '@/lib/constants'
import { getOrCreateIngestKey, ingestVisionEvents, serializeVisionEvent } from '@/lib/vision'

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['vision'])
    const limitRaw = new URL(req.url).searchParams.get('limit')
    let limit = 100
    if (limitRaw != null && limitRaw !== '') {
      const n = Number(limitRaw)
      if (!Number.isInteger(n) || n < 1 || n > 200) {
        throw new ApiError('limit must be between 1 and 200', 400)
      }
      limit = n
    }
    const events = await db.visionEvent.findMany({
      orderBy: [{ detectedAt: 'desc' }, { id: 'desc' }],
      take: limit,
    })
    return NextResponse.json({ events: events.map(serializeVisionEvent) })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    // ── Auth: session with 'vision' OR ingest key ──
    // A valid session WITHOUT the vision permission is a hard 403 (no key
    // fallback); an anonymous client falls back to the ingest key check.
    let sessionOk = false
    let keyUsed = false
    try {
      await requireAuth(req, ['vision'])
      sessionOk = true
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) throw err
      sessionOk = false
    }
    if (!sessionOk) {
      const key = await getOrCreateIngestKey()
      const authHeader = req.headers.get('authorization')
      const bearerKey = authHeader?.toLowerCase().startsWith('bearer ')
        ? authHeader.slice(7).trim()
        : null
      const headerKey = req.headers.get('x-vision-key')
      // R16: constant-time comparison (timingSafeEqual) — a plain === on the
      // ingest key leaks an early-exit timing signal, unlike the sync import
      // route which already did this correctly.
      const safeEqual = (a: string, b: string): boolean => {
        const ab = Buffer.from(a, 'utf8')
        const bb = Buffer.from(b, 'utf8')
        return ab.length === bb.length && timingSafeEqual(ab, bb)
      }
      const presented = bearerKey ?? headerKey
      if (presented != null && safeEqual(presented, key)) {
        keyUsed = true
      } else {
        throw new ApiError('Unauthorized vision client', 401)
      }
    }

    // ── Rate limit AFTER auth (per ingest key, else per client IP) ──
    const rateKey = 'vision-ingest:' + (keyUsed ? 'key' : clientIp(req))
    const rl = checkRateLimit(rateKey, VISION_INGEST_RATE_LIMIT, 60_000)
    if (!rl.ok) {
      return NextResponse.json(
        { error: 'Rate limit exceeded' },
        { status: 429, headers: { 'Retry-After': String(rl.retryAfterSec) } },
      )
    }

    // ── Body: a single event OR { events: [...] } ──
    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })
    const { results } = await ingestVisionEvents(body, 'edge')
    // Individual bad events are 'rejected' results, never request failures.
    return NextResponse.json({ results })
  } catch (err) {
    return errorResponse(err)
  }
}
