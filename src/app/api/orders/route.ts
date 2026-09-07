// /api/orders — order creation (waiter/admin) + listing (any authenticated)

import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import {
  ORDER_INCLUDE,
  checkStockAvailability,
  parseId,
  recomputeTotals,
  serializeOrder,
  sessionUserId,
  validateOrderItems,
} from '@/lib/orders'

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req)
    const { searchParams } = new URL(req.url)
    const status = searchParams.get('status') ?? 'open'
    const tableIdParam = searchParams.get('tableId')

    const where: Prisma.OrderWhereInput = {}
    if (status === 'open' || status === 'paid' || status === 'cancelled') {
      where.status = status
    } else if (status !== 'all') {
      throw new ApiError(`Invalid status filter "${status}"`, 400)
    }
    if (tableIdParam != null && tableIdParam !== '') {
      where.tableId = parseId(tableIdParam, 'tableId filter')
    }

    const orders = await db.order.findMany({
      where,
      include: ORDER_INCLUDE,
      orderBy: { createdAt: 'asc' },
    })
    return NextResponse.json({ orders: orders.map(serializeOrder) })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth(req, ['waiter', 'admin'])
    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })

    // Optional table: must exist, be active and have no open order yet
    let table: { id: number; name: string } | null = null
    if (body?.tableId != null) {
      const tableId = parseId(String(body.tableId), 'tableId')
      const found = await db.restaurantTable.findUnique({ where: { id: tableId } })
      if (!found || !found.active) throw new ApiError('Table not found', 404)
      const openOrder = await db.order.findFirst({
        where: { tableId, status: 'open' },
        select: { id: true },
      })
      if (openOrder) {
        throw new ApiError(`Table "${found.name}" already has an open order`, 400)
      }
      table = { id: found.id, name: found.name }
    }

    // Items: products must exist / be active / sellable, qty > 0, course valid
    const items = await validateOrderItems(body?.items)

    // Stock check for the whole new order
    await checkStockAvailability(items)

    // Create order + items + occupy table atomically
    const created = await db.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          userId: sessionUserId(session),
          tableId: table?.id ?? null,
          items: {
            create: items.map((item) => ({
              productId: item.productId,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              notes: item.notes,
              course: item.course,
              status: 'new',
            })),
          },
        },
      })
      if (table) {
        await tx.restaurantTable.update({
          where: { id: table.id },
          data: { status: 'occupied' },
        })
      }
      return order
    })

    // Persist subtotal/tax/total from the created items
    const order = await recomputeTotals(created.id)
    return NextResponse.json({ order })
  } catch (err) {
    return errorResponse(err)
  }
}
