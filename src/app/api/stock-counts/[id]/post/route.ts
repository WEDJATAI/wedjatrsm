// /api/stock-counts/[id]/post — post a count sheet's variances to inventory.
// ONLY from status 'open'. In one $transaction, every line with a counted
// quantity and |variance| > 0.001 creates an InventoryTransaction with
// reason 'adjustment' and moves the product stock by the variance (mirrors
// the /api/inventory/adjust ledger behavior). The sheet then becomes
// 'posted' (terminal) — a second post attempt is a 409.

import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAuth, errorResponse, ApiError } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { emitOutboxEvent } from '@/lib/hybrid-sync/outbox'
import type { StockCountDTO, StockCountLineDTO } from '@/lib/types'

const round2 = (n: number): number => Math.round(n * 100) / 100

/** variances at or below this magnitude count as "no difference" */
const VARIANCE_EPSILON = 0.001

const SC_INCLUDE = {
  createdBy: { select: { name: true } },
  lines: {
    orderBy: { id: 'asc' },
    include: {
      product: { select: { id: true, name: true, nameAr: true, sku: true, cost: true } },
    },
  },
} satisfies Prisma.StockCountInclude

type ScRow = Prisma.StockCountGetPayload<{ include: typeof SC_INCLUDE }>

/** Serialize a sheet + lines into the StockCountDTO API payload. */
function toStockCountDTO(sc: ScRow): StockCountDTO {
  const lines: StockCountLineDTO[] = sc.lines.map((line) => {
    const variance =
      line.countedQty === null ? null : round2(line.countedQty - line.systemQty)
    return {
      id: line.id,
      productId: line.productId,
      product: line.product,
      systemQty: line.systemQty,
      countedQty: line.countedQty,
      variance,
      valueImpact: variance === null ? null : round2(variance * line.product.cost),
    }
  })
  const totalValueImpact = round2(
    lines.reduce((sum, l) => sum + Math.abs(l.valueImpact ?? 0), 0),
  )
  return {
    id: sc.id,
    number: sc.number,
    status: sc.status,
    note: sc.note,
    createdAt: sc.createdAt.toISOString(),
    postedAt: sc.postedAt ? sc.postedAt.toISOString() : null,
    createdBy: sc.createdBy?.name ?? null,
    lines,
    totalValueImpact,
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireAuth(req, ['admin', 'inventory'])

    const { id } = await params
    const sheetId = Number(id)
    if (!Number.isInteger(sheetId)) throw new ApiError('Invalid count sheet id', 400)

    const sheet = await db.stockCount.findUnique({
      where: { id: sheetId },
      include: { lines: true },
    })
    if (!sheet) throw new ApiError('Count sheet not found', 404)
    if (sheet.status !== 'open') {
      throw new ApiError(
        `Count sheet is ${sheet.status} — only open sheets can be posted`,
        409,
      )
    }

    // Variance lines: counted, with a real difference beyond tolerance.
    // countedQty ≥ 0 means the adjusted stock (= counted qty) can never go
    // below zero, so no insufficient-stock check is needed here.
    const varianceLines = sheet.lines.filter(
      (line) =>
        line.countedQty !== null &&
        Math.abs(line.countedQty - line.systemQty) > VARIANCE_EPSILON,
    )

    // R38 hybrid sync: every write in the post rides the outbox atomically
    // with the business writes — InventoryTransaction 'create' per stock
    // adjustment (append-only ledger), Product 'update' per stock move
    // (cloud-authoritative; without it the other terminals' stock levels
    // diverge — an InventoryTransaction event alone never touches stock),
    // and the terminal status flip as StockCount 'update'. The response
    // sheet is re-read with its relations afterwards.
    await db.$transaction(async (tx) => {
      for (const line of varianceLines) {
        const variance = (line.countedQty as number) - line.systemQty
        const ledgerRow = await tx.inventoryTransaction.create({
          data: {
            productId: line.productId,
            quantityChange: variance,
            reason: 'adjustment',
          },
        })
        await emitOutboxEvent(tx, {
          entity: 'InventoryTransaction',
          entityId: ledgerRow.id,
          operation: 'create',
          row: ledgerRow,
        })
        const productRow = await tx.product.update({
          where: { id: line.productId },
          data: { stock: { increment: variance } },
        })
        await emitOutboxEvent(tx, {
          entity: 'Product',
          entityId: productRow.id,
          operation: 'update',
          row: productRow,
        })
      }
      const row = await tx.stockCount.update({
        where: { id: sheetId },
        data: { status: 'posted', postedAt: new Date() },
      })
      await emitOutboxEvent(tx, {
        entity: 'StockCount',
        entityId: row.id,
        operation: 'update',
        row,
      })
    })
    const updated = await db.stockCount.findUniqueOrThrow({
      where: { id: sheetId },
      include: SC_INCLUDE,
    })

    await logAudit({
      user,
      action: 'stockcount.post',
      entity: 'stockcount',
      entityId: sheet.id,
      details: `${sheet.number} posted — ${varianceLines.length} adjustment line(s)${
        sheet.note ? ` (${sheet.note})` : ''
      }`,
    })

    return NextResponse.json({
      stockCount: toStockCountDTO(updated),
      postedAdjustments: varianceLines.length,
    })
  } catch (err) {
    return errorResponse(err)
  }
}
