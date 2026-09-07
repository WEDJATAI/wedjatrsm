// /api/tables — table creation (admin)

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { serializeTable } from '@/lib/orders'

function parsePercent(value: unknown, label: string): number {
  const num = Number(value)
  if (!Number.isFinite(num) || num < 0 || num > 100) {
    throw new ApiError(`${label} must be a number between 0 and 100`, 400)
  }
  return num
}

export async function POST(req: NextRequest) {
  try {
    await requireAuth(req, ['admin', 'floorplans'])
    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })

    const floorPlanId = Number(body?.floorPlanId)
    if (!Number.isInteger(floorPlanId) || floorPlanId <= 0) {
      throw new ApiError('floorPlanId is required', 400)
    }
    const floorPlan = await db.floorPlan.findUnique({ where: { id: floorPlanId } })
    if (!floorPlan) throw new ApiError('Floor plan not found', 404)

    const name = String(body?.name ?? '').trim()
    if (!name) throw new ApiError('Table name is required', 400)

    let capacity = 2
    if (body?.capacity != null) {
      capacity = Number(body.capacity)
      if (!Number.isInteger(capacity) || capacity < 1) {
        throw new ApiError('capacity must be an integer of at least 1', 400)
      }
    }

    const positionX = body?.positionX == null ? 50 : parsePercent(body.positionX, 'positionX')
    const positionY = body?.positionY == null ? 50 : parsePercent(body.positionY, 'positionY')

    const table = await db.restaurantTable.create({
      data: { floorPlanId, name, capacity, positionX, positionY },
    })
    return NextResponse.json({ table: serializeTable(table) })
  } catch (err) {
    return errorResponse(err)
  }
}
