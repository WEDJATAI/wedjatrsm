// /api/vision/overview — live observational overview (admin + 'vision')

import { NextRequest, NextResponse } from 'next/server'
import { errorResponse, requireAuth } from '@/lib/auth'
import { buildVisionOverview } from '@/lib/vision'

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['vision'])
    const overview = await buildVisionOverview()
    return NextResponse.json({ overview })
  } catch (err) {
    return errorResponse(err)
  }
}
