// /api/stock-counts/[id]/counts — save counted quantities for an OPEN sheet.
// PUT {lines: [{productId, countedQty (number ≥ 0)}]} updates the matching
// snapshot lines; uncounted lines keep countedQty = null. Returns the
// updated StockCountDTO so the UI shows variance/value impact immediately.

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

type CountInput = { productId: number; countedQty: number }

/** Validate + normalize the request lines array. */
function parseCountInputs(raw: unknown): CountInput[] {
  if (!Array.isArray(raw)) {
    throw new ApiError('lines must be an array of {productId, countedQty}', 400)
  }
  if (raw.length > 1000) throw new ApiError('lines cannot exceed 1000 entries', 400)
  const seen = new Set<number>()
  const inputs: CountInput[] = []
  for (const entry of raw) {
    const record = (entry ?? {}) as Record<string, unknown>
    const productId = Number(record.productId)
    if (!Number.isInteger(productId)) {
      throw new ApiError('productId must be an integer', 400)
    }
    if (seen.has(productId)) {
      throw new ApiError(`Duplicate productId ${productId} in lines`, 400)
    }
    seen.add(productId)
    const countedQty = Number(record.countedQty)
    if (!Number.isFinite(countedQty) || countedQty < 0) {
      throw new ApiError('countedQty must be a number ≥ 0', 400)
    }
    inputs.push({ productId, countedQty })
  }
  return inputs
}

export async function PUT(
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
      throw new ApiError('Invalid JSON body', 400)
    }
    const data = (body ?? {}) as Record<string, unknown>
    const inputs = parseCountInputs(data.lines)

    const sheet = await db.stockCount.findUnique({
      where: { id: sheetId },
      include: { lines: { select: { id: true, productId: true } } },
    })
    if (!sheet) throw new ApiError('Count sheet not found', 404)
    if (sheet.status !== 'open') {
      throw new ApiError(
        `Count sheet is ${sheet.status} — counts can only be saved while open`,
        409,
      )
    }

    // Every requested productId must exist on THIS sheet's snapshot.
    const lineByProduct = new Map(sheet.lines.map((l) => [l.productId, l.id]))
    for (const input of inputs) {
      if (!lineByProduct.has(input.productId)) {
        throw new ApiError(
          `Product ${input.productId} is not on count sheet ${sheet.number}`,
          400,
        )
      }
    }

    const updated = await db.$transaction(async (tx) => {
      for (const input of inputs) {
        await tx.stockCountLine.update({
          where: { id: lineByProduct.get(input.productId) as number },
          data: { countedQty: input.countedQty },
        })
      }
      return tx.stockCount.findUnique({ where: { id: sheetId }, include: SC_INCLUDE })
    })
    if (!updated) throw new ApiError('Count sheet not found', 404)

    await logAudit({
      user,
      action: 'stockcount.saveCounts',
      entity: 'stockcount',
      entityId: sheet.id,
      details: `${sheet.number} — saved ${inputs.length} count(s)`,
    })

    return NextResponse.json({ stockCount: toStockCountDTO(updated) })
  } catch (err) {
    return errorResponse(err)
  }
}
