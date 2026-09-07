import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, errorResponse } from '@/lib/auth'
import type { InventoryValueReport } from '@/lib/types'

const round2 = (n: number): number => Math.round(n * 100) / 100

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['admin'])

    const products = await db.product.findMany({
      where: { isStockable: true, active: true },
    })

    let totalValueRaw = 0
    let lowStockCount = 0
    for (const p of products) {
      totalValueRaw += p.cost * p.stock
      if (p.stock <= p.lowStockThreshold) lowStockCount += 1
    }

    const report: InventoryValueReport = {
      totalValue: round2(totalValueRaw),
      itemCount: products.length,
      lowStockCount,
    }

    return NextResponse.json(report)
  } catch (err) {
    return errorResponse(err)
  }
}
