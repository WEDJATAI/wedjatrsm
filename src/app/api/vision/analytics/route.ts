// /api/vision/analytics — occupancy / movement analytics over a date window
// (admin + 'vision' permission). Query: ?from&to (YYYY-MM-DD; defaults:
// from = 7 days ago, to = today).

import { NextRequest, NextResponse } from 'next/server'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { buildVisionAnalytics } from '@/lib/vision'

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

function parseDay(raw: string, endOfDay: boolean): Date {
  const [y, m, d] = raw.split('-').map(Number)
  return endOfDay ? new Date(y, m - 1, d, 23, 59, 59, 999) : new Date(y, m - 1, d)
}

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['vision'])
    const sp = new URL(req.url).searchParams
    const fromRaw = sp.get('from')
    const toRaw = sp.get('to')

    const today = new Date()
    let from = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 7)
    let to = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59, 999)

    if (fromRaw != null && fromRaw !== '') {
      if (!DATE_ONLY_RE.test(fromRaw)) {
        throw new ApiError('Invalid from date (expected YYYY-MM-DD)', 400)
      }
      from = parseDay(fromRaw, false)
    }
    if (toRaw != null && toRaw !== '') {
      if (!DATE_ONLY_RE.test(toRaw)) {
        throw new ApiError('Invalid to date (expected YYYY-MM-DD)', 400)
      }
      to = parseDay(toRaw, true)
    }
    if (from > to) throw new ApiError('from must not be after to', 400)

    const analytics = await buildVisionAnalytics(from, to)
    return NextResponse.json({ analytics })
  } catch (err) {
    return errorResponse(err)
  }
}
