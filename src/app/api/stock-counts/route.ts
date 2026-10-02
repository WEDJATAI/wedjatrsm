// /api/stock-counts — physical inventory count sheets (Foodics Stock Count).
// POST opens a sheet that snapshots EVERY active stockable product at its
// current stock (systemQty); GET lists sheets newest-first with per-line
// variance (countedQty − systemQty) and value impact (variance × cost).
// Posting the variances lives in [id]/post; counts are saved via [id]/counts.

import { NextRequest, NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { requireAuth, errorResponse } from '@/lib/auth'
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

/** Next sheet number: "SC-" + zero-padded 4, max existing suffix + 1. */
function nextSheetNumber(existing: { number: string }[]): string {
  let maxSuffix = 0
  for (const row of existing) {
    const m = /^SC-(\d+)$/.exec(row.number)
    if (m) maxSuffix = Math.max(maxSuffix, Number(m[1]))
  }
  return `SC-${String(maxSuffix + 1).padStart(4, '0')}`
}

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['admin', 'inventory'])

    const sheets = await db.stockCount.findMany({
      orderBy: { createdAt: 'desc' },
      include: SC_INCLUDE,
    })

    return NextResponse.json({ stockCounts: sheets.map(toStockCountDTO) })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireAuth(req, ['admin', 'inventory'])

    let body: unknown
    try {
      body = await req.json()
    } catch {
      body = {}
    }
    const data = (body ?? {}) as Record<string, unknown>

    const note =
      typeof data.note === 'string' && data.note.trim() !== '' ? data.note.trim() : null

    const sheet = await db.$transaction(async (tx) => {
      const existing = await tx.stockCount.findMany({ select: { number: true } })
      const number = nextSheetNumber(existing)

      // Snapshot EVERY active stockable product at its current stock.
      const products = await tx.product.findMany({
        where: { active: true, isStockable: true },
        orderBy: { name: 'asc' },
        select: { id: true, stock: true },
      })

      return tx.stockCount.create({
        data: {
          number,
          note,
          createdById: user.userId,
          lines: {
            create: products.map((p) => ({ productId: p.id, systemQty: p.stock })),
          },
        },
        include: SC_INCLUDE,
      })
    })

    await logAudit({
      user,
      action: 'stockcount.create',
      entity: 'stockcount',
      entityId: sheet.id,
      details: `${sheet.number} opened — ${sheet.lines.length} item(s)${
        note ? ` — ${note}` : ''
      }`,
    })

    return NextResponse.json({ stockCount: toStockCountDTO(sheet) }, { status: 201 })
  } catch (err) {
    return errorResponse(err)
  }
}
