// /api/orders — order creation (waiter/admin) + listing (any authenticated)

import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { MAX_SEATING_TABLES, ORDER_TYPES } from '@/lib/constants'
import {
  ORDER_INCLUDE,
  checkStockAvailability,
  findOpenOrderOnTable,
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
    if (
      status === 'open' ||
      status === 'paid' ||
      status === 'cancelled' ||
      status === 'deferred'
    ) {
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
    const session = await requireAuth(req, ['waiter', 'admin', 'pos'])
    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })

    // Optional table(s): single tableId (classic) or tableIds array
    // (merged seating from the beginning — party spans multiple tables).
    let tables: { id: number; name: string }[] = []
    if (Array.isArray(body?.tableIds) && body.tableIds.length > 0) {
      const rawIds = body.tableIds.map(Number)
      if (rawIds.some((id) => !Number.isInteger(id) || id <= 0)) {
        throw new ApiError('tableIds contains an invalid table id', 400)
      }
      if (rawIds.length > MAX_SEATING_TABLES) {
        throw new ApiError(`A seating can span at most ${MAX_SEATING_TABLES} tables`, 400)
      }
      if (new Set(rawIds).size !== rawIds.length) {
        throw new ApiError('tableIds contains duplicates', 400)
      }
      for (const id of rawIds) {
        const found = await db.restaurantTable.findUnique({ where: { id } })
        if (!found || !found.active) throw new ApiError('Table not found', 404)
        const openOrder = await findOpenOrderOnTable(id)
        if (openOrder) {
          throw new ApiError(`Table "${found.name}" already has an open order`, 400)
        }
        tables.push({ id: found.id, name: found.name })
      }
    } else if (body?.tableId != null) {
      const tableId = parseId(String(body.tableId), 'tableId')
      const found = await db.restaurantTable.findUnique({ where: { id: tableId } })
      if (!found || !found.active) throw new ApiError('Table not found', 404)
      const openOrder = await findOpenOrderOnTable(tableId)
      if (openOrder) {
        throw new ApiError(`Table "${found.name}" already has an open order`, 400)
      }
      tables.push({ id: found.id, name: found.name })
    }
    const table = tables.length > 0 ? tables[0] : null
    const extraTables = tables.slice(1)

    // R11: order type — defaults to the classic behavior (table → dine-in,
    // table-less → takeaway). 'delivery' requires a contact phone.
    let orderType: string = table != null ? 'dinein' : 'takeaway'
    if (body?.orderType != null) {
      const rawType = String(body.orderType)
      if (!(ORDER_TYPES as readonly string[]).includes(rawType)) {
        throw new ApiError(`orderType must be one of: ${ORDER_TYPES.join(', ')}`, 400)
      }
      orderType = rawType
    }
    if (table != null && orderType !== 'dinein') {
      throw new ApiError(`${orderType} orders cannot be bound to a table`, 400)
    }
    let deliveryPhone: string | null = null
    let deliveryAddress: string | null = null
    if (orderType === 'delivery') {
      const rawPhone = body?.deliveryPhone == null ? '' : String(body.deliveryPhone).trim()
      if (rawPhone.length < 5 || rawPhone.length > 20) {
        throw new ApiError('Delivery orders require a customer phone (5-20 characters)', 400)
      }
      deliveryPhone = rawPhone
      if (body?.deliveryAddress != null) {
        const rawAddress = String(body.deliveryAddress).trim()
        if (rawAddress.length > 200) {
          throw new ApiError('Delivery address is too long (max 200 characters)', 400)
        }
        deliveryAddress = rawAddress || null
      }
    }

    // Guests: integer 1-30, default 2 for table orders / 1 for takeaway
    let guests = table != null ? 2 : 1
    if (body?.guests != null) {
      const parsedGuests = Number(body.guests)
      if (!Number.isInteger(parsedGuests) || parsedGuests < 1 || parsedGuests > 30) {
        throw new ApiError('Guests must be between 1 and 30', 400)
      }
      guests = parsedGuests
    }

    // Items: products must exist / be active / sellable, qty > 0, course valid
    const items = await validateOrderItems(body?.items)

    // Stock check for the whole new order
    await checkStockAvailability(items)

    // Create order + items + occupy ALL seating tables atomically
    const created = await db.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          userId: sessionUserId(session),
          tableId: table?.id ?? null,
          orderType,
          deliveryPhone,
          deliveryAddress,
          extraTableIds:
            extraTables.length > 0 ? JSON.stringify(extraTables.map((t) => t.id)) : null,
          guests,
          items: {
            create: items.map((item) => ({
              productId: item.productId,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              notes: item.notes,
              course: item.course,
              status: 'new',
              // R8: option snapshot (validated server-side by validateOrderItems)
              selectedModifiers: item.selectedModifiers
                ? JSON.stringify(item.selectedModifiers)
                : undefined,
            })),
          },
        },
      })
      for (const seatTable of tables) {
        await tx.restaurantTable.update({
          where: { id: seatTable.id },
          data: { status: 'occupied' },
        })
      }
      return order
    })

    // Persist subtotal/tax/total from the created items
    const order = await recomputeTotals(created.id)

    // R11: auto-link a seated reservation on this table to its new order
    // (fire-and-forget — booking traceability must never block an order).
    if (table != null) {
      await db.reservation
        .updateMany({
          where: { tableId: table.id, status: 'seated', orderId: null },
          data: { orderId: order.id },
        })
        .catch(() => undefined)
    }

    await logAudit({
      user: session,
      action: 'order.create',
      entity: 'order',
      entityId: order.id,
      details:
        `EGP ${order.totalAmount.toFixed(2)} — ${
          tables.length > 1
            ? `Tables ${tables.map((t) => t.name).join(' + ')} (merged seating)`
            : table
              ? `Table ${table.name}`
              : orderType === 'delivery'
                ? `delivery (phone ${deliveryPhone})`
                : 'takeaway'
        }, ${order.items.length} item(s), ${guests} guest(s)`,
    })

    return NextResponse.json({ order })
  } catch (err) {
    return errorResponse(err)
  }
}
