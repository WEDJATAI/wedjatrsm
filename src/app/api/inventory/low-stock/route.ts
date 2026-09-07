import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, errorResponse } from '@/lib/auth'
import type { InventoryItem } from '@/lib/types'

const round2 = (n: number): number => Math.round(n * 100) / 100

/** Map a stockable product row to the InventoryItem API payload. */
function toInventoryItem(p: {
  id: number
  name: string
  sku: string | null
  stock: number
  cost: number
  lowStockThreshold: number
}): InventoryItem {
  const isLow = p.stock <= p.lowStockThreshold
  return {
    productId: p.id,
    name: p.name,
    sku: p.sku,
    stock: p.stock,
    cost: p.cost,
    value: round2(p.cost * p.stock),
    lowStockThreshold: p.lowStockThreshold,
    isLow,
  }
}

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['waiter', 'admin', 'inventory'])

    // Column-to-column comparison (stock <= lowStockThreshold) is not supported by
    // Prisma where clauses, so filter in JS after fetching stockable+active rows.
    const products = await db.product.findMany({
      where: { isStockable: true, active: true },
      orderBy: { name: 'asc' },
    })

    const items: InventoryItem[] = products
      .filter((p) => p.stock <= p.lowStockThreshold)
      .map((p) => toInventoryItem(p))

    return NextResponse.json({ items })
  } catch (err) {
    return errorResponse(err)
  }
}
