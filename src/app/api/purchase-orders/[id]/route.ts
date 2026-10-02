// /api/purchase-orders/[id] — R17 Purchasing: single PO + lifecycle actions.
// GET   → { purchaseOrder: PurchaseOrderDTO } (404 when missing)
// PATCH → { action: 'confirm' | 'cancel' | 'receive' }
//   confirm: draft → ordered (orderedAt = now), audit 'purchase.confirm'
//   cancel:  draft|ordered → cancelled (audit 'purchase.cancel'); a RECEIVED
//            PO can never be cancelled → 409
//   receive: ONLY from 'ordered'. Body lines: [{lineId, receivedQty}] where
//            receivedQty is the NEW CUMULATIVE received total for the line —
//            clamped to [0, quantity]. For every positive delta an
//            InventoryTransaction 'purchase' row is written, product stock is
//            incremented and product.cost revalued to the line's unit cost
//            (last-purchase price). When every line is fully received the PO
//            flips to 'received' + receivedAt, otherwise it stays 'ordered'
//            (partial receiving). All in a $transaction; audit 'purchase.receive'.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, errorResponse, ApiError } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { round2 } from '@/lib/orders'
import type { PurchaseOrderDTO } from '@/lib/types'

/** Quantities within this tolerance count as fully received. */
const QTY_EPSILON = 0.001

type POLineRow = {
  id: number
  productId: number
  product: { id: number; name: string; nameAr: string | null; sku: string | null; cost: number }
  quantity: number
  receivedQuantity: number
  unitCost: number
}

type PORow = {
  id: number
  number: string
  supplierId: number
  supplier: { id: number; name: string }
  status: string
  note: string | null
  expectedAt: Date | null
  orderedAt: Date | null
  receivedAt: Date | null
  createdAt: Date
  createdBy: { name: string } | null
  lines: POLineRow[]
}

const PO_INCLUDE = {
  supplier: { select: { id: true, name: true } },
  createdBy: { select: { name: true } },
  lines: {
    include: { product: { select: { id: true, name: true, nameAr: true, sku: true, cost: true } } },
    orderBy: { id: 'asc' as const },
  },
} as const

function serializePO(po: PORow): PurchaseOrderDTO {
  let totalRaw = 0
  let receivedRaw = 0
  let outstandingRaw = 0
  const lines = po.lines.map((line) => {
    const lineTotal = round2(line.quantity * line.unitCost)
    totalRaw += line.quantity * line.unitCost
    receivedRaw += line.receivedQuantity * line.unitCost
    const remaining = Math.max(0, line.quantity - line.receivedQuantity)
    outstandingRaw += remaining * line.unitCost
    return {
      id: line.id,
      productId: line.productId,
      product: line.product,
      quantity: line.quantity,
      receivedQuantity: line.receivedQuantity,
      unitCost: line.unitCost,
      lineTotal,
    }
  })
  return {
    id: po.id,
    number: po.number,
    supplierId: po.supplierId,
    supplier: po.supplier,
    status: po.status,
    note: po.note,
    expectedAt: po.expectedAt ? po.expectedAt.toISOString() : null,
    orderedAt: po.orderedAt ? po.orderedAt.toISOString() : null,
    receivedAt: po.receivedAt ? po.receivedAt.toISOString() : null,
    createdAt: po.createdAt.toISOString(),
    createdBy: po.createdBy?.name ?? null,
    lines,
    total: round2(totalRaw),
    receivedTotal: round2(receivedRaw),
    outstanding: round2(outstandingRaw),
  }
}

function parseIdParam(id: string): number {
  const n = Number(id)
  if (!Number.isInteger(n) || n <= 0) throw new ApiError('Invalid purchase order id', 400)
  return n
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAuth(req, ['admin', 'purchases'])
    const id = parseIdParam((await params).id)

    const po = (await db.purchaseOrder.findUnique({
      where: { id },
      include: PO_INCLUDE,
    })) as PORow | null
    if (!po) throw new ApiError('Purchase order not found', 404)

    return NextResponse.json({ purchaseOrder: serializePO(po) })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAuth(req, ['admin', 'purchases'])
    const id = parseIdParam((await params).id)

    let body: unknown
    try {
      body = await req.json()
    } catch {
      throw new ApiError('Invalid JSON body', 400)
    }
    const data = (body ?? {}) as Record<string, unknown>
    const action = typeof data.action === 'string' ? data.action : ''

    const existing = (await db.purchaseOrder.findUnique({
      where: { id },
      include: PO_INCLUDE,
    })) as PORow | null
    if (!existing) throw new ApiError('Purchase order not found', 404)

    // ── confirm: draft → ordered ──
    if (action === 'confirm') {
      if (existing.status !== 'draft') {
        throw new ApiError(
          `Only draft purchase orders can be confirmed (this one is ${existing.status})`,
          400,
        )
      }
      const updated = (await db.purchaseOrder.update({
        where: { id },
        data: { status: 'ordered', orderedAt: new Date() },
        include: PO_INCLUDE,
      })) as PORow
      await logAudit({
        user,
        action: 'purchase.confirm',
        entity: 'purchase',
        entityId: id,
        details: `${updated.number} — ${updated.supplier.name} · ordered (${updated.lines.length} line(s), total ${round2(
          updated.lines.reduce((s, l) => s + l.quantity * l.unitCost, 0),
        )})`,
      })
      return NextResponse.json({ purchaseOrder: serializePO(updated) })
    }

    // ── cancel: draft|ordered → cancelled (received is locked) ──
    if (action === 'cancel') {
      if (existing.status === 'received') {
        throw new ApiError('Received purchase orders cannot be cancelled', 409)
      }
      if (existing.status === 'cancelled') {
        throw new ApiError('Purchase order is already cancelled', 400)
      }
      const updated = (await db.purchaseOrder.update({
        where: { id },
        data: { status: 'cancelled' },
        include: PO_INCLUDE,
      })) as PORow
      await logAudit({
        user,
        action: 'purchase.cancel',
        entity: 'purchase',
        entityId: id,
        details: `${updated.number} — ${updated.supplier.name} · cancelled from ${existing.status}`,
      })
      return NextResponse.json({ purchaseOrder: serializePO(updated) })
    }

    // ── receive: ordered → (partial) ordered | received ──
    if (action === 'receive') {
      if (existing.status !== 'ordered') {
        throw new ApiError(
          `Only ordered purchase orders can be received (this one is ${existing.status})`,
          400,
        )
      }
      if (!Array.isArray(data.lines) || data.lines.length === 0) {
        throw new ApiError('lines must be a non-empty array of {lineId, receivedQty}', 400)
      }

      // Validate + clamp the request against the CURRENT line state.
      const lineMap = new Map(existing.lines.map((l) => [l.id, l]))
      const plan: { line: POLineRow; newReceived: number; delta: number }[] = []
      for (const [index, raw] of data.lines.entries()) {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new ApiError(`lines[${index}] must be an object`, 400)
        }
        const entry = raw as Record<string, unknown>
        const lineId = Number(entry.lineId)
        if (!Number.isInteger(lineId)) {
          throw new ApiError(`lines[${index}].lineId must be an integer`, 400)
        }
        const target = lineMap.get(lineId)
        if (!target) {
          throw new ApiError(`lineId ${lineId} does not belong to this purchase order`, 400)
        }
        const receivedQty = Number(entry.receivedQty)
        if (!Number.isFinite(receivedQty)) {
          throw new ApiError(`lines[${index}].receivedQty must be a number`, 400)
        }
        // cumulative total clamped to the ordered quantity
        const newReceived = Math.min(Math.max(receivedQty, 0), target.quantity)
        if (newReceived < target.receivedQuantity - QTY_EPSILON) {
          // Stock already landed for the earlier receipt — a reduction would
          // silently corrupt the ledger, so it is rejected (re-count instead).
          throw new ApiError(
            `Line ${lineId}: received quantity cannot be reduced (already ${target.receivedQuantity})`,
            400,
          )
        }
        const delta = round2(newReceived - target.receivedQuantity)
        plan.push({ line: target, newReceived, delta })
      }

      const totalDelta = round2(plan.reduce((s, p) => s + p.delta, 0))
      const linesWithDelta = plan.filter((p) => p.delta > 0).length

      const updated = await db.$transaction(async (tx) => {
        for (const step of plan) {
          if (step.delta > 0) {
            // stock lands + last-purchase-price revaluation
            await tx.inventoryTransaction.create({
              data: {
                productId: step.line.productId,
                quantityChange: step.delta,
                reason: 'purchase',
              },
            })
            await tx.product.update({
              where: { id: step.line.productId },
              data: { stock: { increment: step.delta }, cost: step.line.unitCost },
            })
          }
          await tx.purchaseOrderItem.update({
            where: { id: step.line.id },
            data: { receivedQuantity: step.newReceived },
          })
        }

        // fully received? (re-read within the transaction for consistency)
        const freshLines = await tx.purchaseOrderItem.findMany({
          where: { purchaseOrderId: id },
          select: { quantity: true, receivedQuantity: true },
        })
        const fullyReceived =
          freshLines.length > 0 &&
          freshLines.every((l) => l.receivedQuantity >= l.quantity - QTY_EPSILON)

        return tx.purchaseOrder.update({
          where: { id },
          data: fullyReceived
            ? { status: 'received', receivedAt: new Date() }
            : { status: 'ordered' },
          include: PO_INCLUDE,
        })
      })

      await logAudit({
        user,
        action: 'purchase.receive',
        entity: 'purchase',
        entityId: id,
        details: `${updated.number} — ${updated.supplier.name} · ${linesWithDelta} line(s) +${totalDelta} units · status ${updated.status}`,
      })

      return NextResponse.json({ purchaseOrder: serializePO(updated as PORow) })
    }

    throw new ApiError("action must be one of 'confirm', 'cancel', 'receive'", 400)
  } catch (err) {
    return errorResponse(err)
  }
}
