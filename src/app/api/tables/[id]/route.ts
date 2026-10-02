// /api/tables/[id] — partial table update (admin)

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { TABLE_SHAPES } from '@/lib/constants'
import { parseId, serializeTable } from '@/lib/orders'

type Ctx = { params: Promise<{ id: string }> }

export async function PUT(req: NextRequest, ctx: Ctx) {
  try {
    await requireAuth(req, ['admin', 'floorplans'])
    const { id } = await ctx.params
    const tableId = parseId(id, 'table id')

    const existing = await db.restaurantTable.findUnique({ where: { id: tableId } })
    if (!existing) throw new ApiError('Table not found', 404)

    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })

    const data: {
      name?: string
      capacity?: number
      positionX?: number
      positionY?: number
      shape?: string
      status?: string
      active?: boolean
    } = {}

    if (body?.name != null) {
      const name = String(body.name).trim()
      if (!name) throw new ApiError('Table name cannot be empty', 400)
      data.name = name
    }
    if (body?.capacity != null) {
      const capacity = Number(body.capacity)
      if (!Number.isInteger(capacity) || capacity < 1) {
        throw new ApiError('capacity must be an integer of at least 1', 400)
      }
      data.capacity = capacity
    }
    if (body?.positionX != null) {
      const positionX = Number(body.positionX)
      if (!Number.isFinite(positionX) || positionX < 0 || positionX > 100) {
        throw new ApiError('positionX must be a number between 0 and 100', 400)
      }
      data.positionX = positionX
    }
    if (body?.positionY != null) {
      const positionY = Number(body.positionY)
      if (!Number.isFinite(positionY) || positionY < 0 || positionY > 100) {
        throw new ApiError('positionY must be a number between 0 and 100', 400)
      }
      data.positionY = positionY
    }
    if (body?.shape != null) {
      const shape = String(body.shape)
      if (!(TABLE_SHAPES as readonly string[]).includes(shape)) {
        throw new ApiError('Invalid shape', 400)
      }
      data.shape = shape
    }
    if (body?.status != null) {
      const status = String(body.status)
      // 'occupied' is system-managed (set by order creation)
      if (status !== 'free' && status !== 'reserved') {
        throw new ApiError(
          `Table status "${status}" cannot be set manually (occupied is system-managed)`,
          400,
        )
      }
      data.status = status
    }
    if (body?.active != null) {
      data.active = Boolean(body.active)
    }

    const table = await db.restaurantTable.update({ where: { id: tableId }, data })
    return NextResponse.json({ table: serializeTable(table) })
  } catch (err) {
    return errorResponse(err)
  }
}
