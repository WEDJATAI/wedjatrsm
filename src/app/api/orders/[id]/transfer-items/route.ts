// /api/orders/[id]/transfer-items — move specific items from this order to
// another OPEN order (waiter/admin). Two payload formats:
//   · `items: [{ id, quantity }]` — moves `quantity` units of each row; when
//     the quantity is less than the row's quantity the row is SPLIT (partial
//     move: new row on the target, remainder stays on the source). This is
//     the "wrong check" fix — e.g. move just 1 of 3 Koshari to another table.
//   · `itemIds: number[]` (legacy) — moves the FULL quantity of each row.
// Inventory and table statuses are untouched (both orders keep their
// tables); payments stay on their orders.
//
// R19 hardening + aggregation:
//   · Destination AGGREGATION — when the target order already has a row
//     with the identical signature (product, unit price, notes, course,
//     status, selected modifiers), the moved units are ADDED to it instead
//     of printing a duplicate line on the check.
//   · Concurrency — partial moves use a compare-and-set decrement
//     (`UPDATE … WHERE quantity >= moved`) inside the transaction, so two
//     staff moving from the same row at the same time can never drive the
//     quantity negative or move more units than the row holds. Both
//     orders' open status is re-verified inside the same transaction.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getOrderOr404, parseId, recomputeTotals, round2, serializeOrder } from '@/lib/orders'
import { MONEY_EPSILON } from '@/lib/constants'

type Ctx = { params: Promise<{ id: string }> }

// A validated move entry: which row and how many units move to the target.
type MoveEntry = { id: number; quantity: number }

/** Fields that make up an order-item "identity" — rows that match on ALL of
 *  these are the same line as far as the printed check is concerned, so
 *  moved units aggregate into the existing row instead of duplicating it. */
type ItemSignature = {
  productId: number | null
  unitPrice: number
  notes: string | null
  course: string
  status: string
  selectedModifiers: string | null
}

function signatureOf(row: {
  productId: number | null
  unitPrice: number
  notes: string | null
  course: string
  status: string
  selectedModifiers: string | null
}): ItemSignature {
  return {
    productId: row.productId,
    unitPrice: round2(row.unitPrice),
    notes: row.notes,
    course: row.course,
    status: row.status,
    selectedModifiers: row.selectedModifiers,
  }
}

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
        // R8: option snapshot — copied verbatim onto split rows below
        selectedModifiers: true,
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

    // Classify: a FULL move re-parents the whole row; a PARTIAL move splits
    // the row — moved units go to the target order (aggregating into an
    // identical row when one exists) and the source row keeps the remainder.
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

    // All writes in ONE transaction. Partial moves are guarded by a
    // compare-and-set decrement (quantity >= moved) so concurrent moves can
    // never corrupt quantities; order statuses are re-verified inside.
    await db.$transaction(async (tx) => {
      // Re-verify both orders are still open INSIDE the transaction (one may
      // have been paid/cancelled between the read above and this write).
      const [srcNow, tgtNow] = await Promise.all([
        tx.order.findUnique({ where: { id: sourceId }, select: { status: true } }),
        tx.order.findUnique({ where: { id: targetOrderId }, select: { status: true } }),
      ])
      if (srcNow?.status !== 'open' || tgtNow?.status !== 'open') {
        throw new ApiError('Only open orders can be modified', 400)
      }

      // Signature index of the target order's existing rows → aggregation.
      const targetRows = await tx.orderItem.findMany({
        where: { orderId: targetOrderId },
        select: {
          id: true,
          productId: true,
          quantity: true,
          unitPrice: true,
          notes: true,
          course: true,
          status: true,
          selectedModifiers: true,
        },
      })
      const targetBySignature = new Map<string, number>() // signature → row id
      for (const row of targetRows) {
        targetBySignature.set(JSON.stringify(signatureOf(row)), row.id)
      }

      // ── Partial moves: CAS decrement + aggregate onto the target ──────
      for (const move of partialMoves) {
        const row = itemById.get(move.id)!
        // Atomic guard: only decrements when the row still holds enough
        // units (returns 0 otherwise → concurrent move already took them).
        const taken = await tx.orderItem.updateMany({
          where: { id: row.id, orderId: sourceId, quantity: { gte: move.quantity } },
          data: { quantity: { decrement: move.quantity } },
        })
        if (taken.count !== 1) {
          throw new ApiError(
            `Cannot move more than the available quantity for item ${row.id}`,
            400,
          )
        }
        // Normalize float drift (e.g. 0.25 kg moves) — read the committed
        // post-decrement value INSIDE the tx so concurrent moves are safe.
        const afterDecrement = await tx.orderItem.findUnique({
          where: { id: row.id },
          select: { quantity: true },
        })
        if (afterDecrement && round2(afterDecrement.quantity) !== afterDecrement.quantity) {
          await tx.orderItem.update({
            where: { id: row.id },
            data: { quantity: round2(afterDecrement.quantity) },
          })
        }
        // Aggregate into an identical target row when present (no duplicate
        // check lines); otherwise create a row carrying just the moved units.
        const signature = JSON.stringify(signatureOf(row))
        const existingTargetRowId = targetBySignature.get(signature)
        if (existingTargetRowId != null) {
          await tx.orderItem.update({
            where: { id: existingTargetRowId },
            data: { quantity: { increment: move.quantity } },
          })
        } else {
          const created = await tx.orderItem.create({
            data: {
              orderId: targetOrderId,
              productId: row.productId,
              quantity: move.quantity,
              unitPrice: row.unitPrice,
              notes: row.notes,
              course: row.course,
              status: row.status,
              selectedModifiers: row.selectedModifiers,
            },
            select: { id: true },
          })
          targetBySignature.set(signature, created.id)
        }
      }

      // ── Full moves: re-parent, aggregating when an identical row exists ──
      for (const move of fullMoves) {
        const row = itemById.get(move.id)!
        const signature = JSON.stringify(signatureOf(row))
        const existingTargetRowId = targetBySignature.get(signature)
        if (existingTargetRowId != null) {
          // Target already shows the identical line: add the units there and
          // drop the source row (the check stays clean — one line, correct total).
          await tx.orderItem.update({
            where: { id: existingTargetRowId },
            data: { quantity: { increment: move.quantity } },
          })
          await tx.orderItem.delete({ where: { id: row.id } })
        } else {
          // Re-parent the fully-moved row onto the target order (identity
          // preserved: same row id, timestamps and modifiers move with it).
          const updated = await tx.orderItem.updateMany({
            where: { id: row.id, orderId: sourceId },
            data: { orderId: targetOrderId },
          })
          if (updated.count !== 1) {
            throw new ApiError(`Item ${row.id} is no longer on this order`, 400)
          }
          targetBySignature.set(signature, row.id)
        }
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
