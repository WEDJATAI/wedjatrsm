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

    const products = await db.product.findMany({
      where: { isStockable: true, active: true },
      orderBy: { name: 'asc' },
    })

    // Low-stock items first, name asc within each group (stable sort keeps name order).
    const items: InventoryItem[] = products
      .map((p) => toInventoryItem(p))
      .sort((a, b) => (a.isLow === b.isLow ? 0 : a.isLow ? -1 : 1))

    return NextResponse.json({ items })
  } catch (err) {
    return errorResponse(err)
  }
}
