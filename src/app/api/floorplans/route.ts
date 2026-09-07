// /api/floorplans — list (any authenticated) + create (admin)

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { serializeFloorPlans } from '@/lib/orders'

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req)
    const includeAll = new URL(req.url).searchParams.get('all') === '1'
    const floorPlans = await db.floorPlan.findMany({
      where: includeAll ? {} : { active: true },
      orderBy: { id: 'asc' },
      include: { tables: { where: { active: true }, orderBy: { name: 'asc' } } },
    })
    return NextResponse.json({ floorPlans: await serializeFloorPlans(floorPlans) })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAuth(req, ['admin'])
    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })
    const name = String(body?.name ?? '').trim()
    if (!name) throw new ApiError('Floor plan name is required', 400)

    const floorPlan = await db.floorPlan.create({ data: { name } })
    return NextResponse.json({
      floorPlan: {
        id: floorPlan.id,
        name: floorPlan.name,
        backgroundImage: floorPlan.backgroundImage,
        active: floorPlan.active,
        tables: [],
      },
    })
  } catch (err) {
    return errorResponse(err)
  }
}
