// /api/stock-counts/[id] — single count sheet (GET) and cancel (PATCH).
// Cancelling is only allowed from 'open' and makes NO stock changes
// (posting is a separate, explicit action in [id]/post).

import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAuth, errorResponse, ApiError } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import type { StockCountDTO, StockCountLineDTO } from '@/lib/types'

const round2 = (n: number): number => Math.round(n * 100) / 100

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

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAuth(req, ['admin', 'inventory'])

    const { id } = await params
    const sheetId = Number(id)
    if (!Number.isInteger(sheetId)) throw new ApiError('Invalid count sheet id', 400)

    const sheet = await db.stockCount.findUnique({
      where: { id: sheetId },
      include: SC_INCLUDE,
    })
    if (!sheet) throw new ApiError('Count sheet not found', 404)

    return NextResponse.json({ stockCount: toStockCountDTO(sheet) })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireAuth(req, ['admin', 'inventory'])

    const { id } = await params
    const sheetId = Number(id)
    if (!Number.isInteger(sheetId)) throw new ApiError('Invalid count sheet id', 400)

    let body: unknown
    try {
      body = await req.json()
    } catch {
      body = {}
    }
    const data = (body ?? {}) as Record<string, unknown>
    if (data.action !== 'cancel') {
      throw new ApiError("action must be 'cancel'", 400)
    }

    const sheet = await db.stockCount.findUnique({ where: { id: sheetId } })
    if (!sheet) throw new ApiError('Count sheet not found', 404)
    if (sheet.status !== 'open') {
      throw new ApiError(
        `Count sheet is ${sheet.status} — only open sheets can be cancelled`,
        409,
      )
    }

    const updated = await db.stockCount.update({
      where: { id: sheetId },
      data: { status: 'cancelled' },
      include: SC_INCLUDE,
    })

    await logAudit({
      user,
      action: 'stockcount.cancel',
      entity: 'stockcount',
      entityId: sheet.id,
      details: `${sheet.number} cancelled (no stock changes)`,
    })

    return NextResponse.json({ stockCount: toStockCountDTO(updated) })
  } catch (err) {
    return errorResponse(err)
  }
}
