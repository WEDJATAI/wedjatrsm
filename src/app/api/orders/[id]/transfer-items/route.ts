// /api/orders/[id]/transfer-items — move specific items from this order to
// another OPEN order (waiter/admin). Two payload formats:
//   · `items: [{ id, quantity }]` — moves `quantity` units of each row; when
//     the quantity is less than the row's quantity the row is SPLIT (partial
//     move: new row on the target, remainder stays on the source). This is
//     the "wrong check" fix — e.g. move just 1 of 3 Koshari to another table.
//   · `itemIds: number[]` (legacy) — moves the FULL quantity of each row.
// Inventory and table statuses are untouched (both orders keep their
// tables); payments stay on their orders.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getOrderOr404, parseId, recomputeTotals, round2, serializeOrder } from '@/lib/orders'
import { MONEY_EPSILON } from '@/lib/constants'

type Ctx = { params: Promise<{ id: string }> }

// A validated move entry: which row and how many units move to the target.
type MoveEntry = { id: number; quantity: number }

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const user = await requireAuth(req, ['waiter', 'admin', 'pos'])
    const { id } = await ctx.params
    const sourceId = parseId(id, 'order id')

    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })
    const targetOrderId = Number(body?.targetOrderId)
    if (body?.targetOrderId == null || !Number.isInteger(targetOrderId) || targetOrderId <= 0) {
      throw new ApiError('targetOrderId is required', 400)
    }
    if (targetOrderId === sourceId) {
      throw new ApiError('Cannot transfer items to the same order', 400)
    }

    // ── Parse the move list ───────────────────────────────────────────
    // New format wins: `items` (per-row quantities, may be partial).
    // Legacy `itemIds` keeps whole-row moves (quantity = the row's own).
    const entries: MoveEntry[] = []
    let legacyIds: number[] | null = null
    if (body?.items != null) {
      const rawItems = body.items
      if (!Array.isArray(rawItems) || rawItems.length === 0) {
        throw new ApiError('items must be a non-empty array', 400)
      }
      const seenIds = new Set<number>()
      for (const raw of rawItems) {
        const itemId = Number(raw?.id)
        const quantity = Number(raw?.quantity)
        if (!Number.isInteger(itemId) || itemId <= 0) {
          throw new ApiError('items contains an invalid item id', 400)
        }
        if (!Number.isFinite(quantity) || quantity <= 0) {
          throw new ApiError('items contains an invalid quantity', 400)
        }
        if (seenIds.has(itemId)) {
          throw new ApiError('Duplicate item id in items', 400)
        }
        seenIds.add(itemId)
        entries.push({ id: itemId, quantity: round2(quantity) })
      }
    } else if (body?.itemIds != null) {
      const rawItemIds = body.itemIds
      if (!Array.isArray(rawItemIds) || rawItemIds.length === 0) {
        throw new ApiError('itemIds is required', 400)
      }
      legacyIds = rawItemIds.map(Number)
      if (legacyIds.some((itemId) => !Number.isInteger(itemId) || itemId <= 0)) {
        throw new ApiError('itemIds contains an invalid item id', 400)
      }
    } else {
      throw new ApiError('items or itemIds is required', 400)
    }

    const source = await db.order.findUnique({ where: { id: sourceId } })
    if (!source) throw new ApiError('Order not found', 404)
    if (source.status !== 'open') {
      throw new ApiError('Only open orders can be modified', 400)
    }

    const target = await db.order.findUnique({ where: { id: targetOrderId } })
    if (!target) throw new ApiError('Target order not found', 404)
    if (target.status !== 'open') {
      throw new ApiError('Only open orders can be modified', 400)
    }

    // Every requested item must exist AND belong to the source order
    // (row fields are needed to split partial moves and build the audit
    // summary — quantity + product name included, read-only).
    const requestedIds = legacyIds ?? entries.map((entry) => entry.id)
    const items = await db.orderItem.findMany({
      where: { id: { in: requestedIds } },
      select: {
        id: true,
        orderId: true,
        productId: true,
        quantity: true,
        unitPrice: true,
        notes: true,
        course: true,
        status: true,
        product: { select: { name: true } },
      },
    })
    const itemById = new Map(items.map((item) => [item.id, item]))
    for (const itemId of requestedIds) {
      const item = itemById.get(itemId)
      if (!item || item.orderId !== sourceId) {
        throw new ApiError(`Item ${itemId} does not belong to this order`, 400)
      }
    }

    // Legacy entries move the FULL row quantity (resolved now that rows are loaded).
    if (legacyIds) {
      for (const itemId of legacyIds) {
        entries.push({ id: itemId, quantity: itemById.get(itemId)!.quantity })
      }
    }

    // A partial move may never take more than the row holds.
    for (const entry of entries) {
      const row = itemById.get(entry.id)!
      if (entry.quantity > row.quantity + MONEY_EPSILON) {
        throw new ApiError(
          `Cannot move more than the available quantity for item ${entry.id}`,
          400,
        )
      }
    }

    // Classify: a FULL move re-parents the whole row (single bulk update);
    // a PARTIAL move splits the row — moved units become a NEW row on the
    // target order (same product/price/notes/course/status) and the source
    // row keeps the remainder (guaranteed > 0 after the clamp above).
    const fullMoves: MoveEntry[] = []
    const partialMoves: MoveEntry[] = []
    for (const entry of entries) {
      const row = itemById.get(entry.id)!
      if (entry.quantity >= row.quantity - MONEY_EPSILON) {
        // clamp to the full row quantity
        fullMoves.push({ id: entry.id, quantity: round2(row.quantity) })
      } else {
        partialMoves.push({ id: entry.id, quantity: entry.quantity })
      }
    }

    // All writes in ONE transaction: rows are never lost or duplicated.
    await db.$transaction(async (tx) => {
      if (fullMoves.length > 0) {
        // Re-parent the fully-moved rows onto the target order (single atomic update)
        await tx.orderItem.updateMany({
          where: { id: { in: fullMoves.map((move) => move.id) } },
          data: { orderId: targetOrderId },
        })
      }
      for (const move of partialMoves) {
        const row = itemById.get(move.id)!
        // New row on the target order carrying just the moved units
        await tx.orderItem.create({
          data: {
            orderId: targetOrderId,
            productId: row.productId,
            quantity: move.quantity,
            unitPrice: row.unitPrice,
            notes: row.notes,
            course: row.course,
            status: row.status,
          },
        })
        // Source row keeps the remaining quantity (round2 keeps it > 0)
        await tx.orderItem.update({
          where: { id: row.id },
          data: { quantity: round2(row.quantity - move.quantity) },
        })
      }
    })

    // Recompute both orders' money fields from their current items.
    // A source left with zero items simply stays open (no auto-cancel).
    await recomputeTotals(sourceId)
    await recomputeTotals(targetOrderId)

    const sourceOrder = await getOrderOr404(sourceId)
    const targetOrder = await getOrderOr404(targetOrderId)

    // Audit summary uses the MOVED quantity per entry (not the row quantity).
    const itemSummary = [...fullMoves, ...partialMoves]
      .map(
        (move) =>
          `${move.quantity}× ${itemById.get(move.id)?.product?.name ?? `item ${move.id}`}`,
      )
      .join(', ')
    await logAudit({
      user,
      action: 'order.itemTransfer',
      entity: 'order',
      entityId: sourceId,
      details: `${itemSummary} moved from order #${sourceId} to order #${targetOrderId}`,
    })

    return NextResponse.json({
      source: serializeOrder(sourceOrder),
      target: serializeOrder(targetOrder),
    })
  } catch (err) {
    return errorResponse(err)
  }
}
