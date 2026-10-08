// /api/reports/menu-engineering — Kasavana-Smith menu engineering (R8)
// GET ?days=7 (default 7, clamped 1..90) → { report: MenuEngineeringReport }
// Analyzes PAID orders in [now − days, now] (order createdAt, like the sales
// report) grouping order items by product: soldQty, revenue, profit (qty ×
// (unitPrice − product.cost — modifiers' cost is not modeled), margin and
// popularity share, then classifies each item against the menu averages.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { round2 } from '@/lib/orders'
import type { MenuItemStat, MenuEngineeringReport } from '@/lib/types'

const DEFAULT_DAYS = 7
const MIN_DAYS = 1
const MAX_DAYS = 90

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['admin', 'reports'])

    const sp = new URL(req.url).searchParams
    const daysRaw = sp.get('days')
    let days = DEFAULT_DAYS
    if (daysRaw !== null && daysRaw !== '') {
      const parsed = Number(daysRaw)
      if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        throw new ApiError('days must be an integer', 400)
      }
      days = Math.min(MAX_DAYS, Math.max(MIN_DAYS, parsed))
    }

    const now = new Date()
    const windowStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)

    const orders = await db.order.findMany({
      where: { status: 'paid', createdAt: { gte: windowStart, lte: now } },
      select: {
        items: {
          select: {
            productId: true,
            quantity: true,
            unitPrice: true,
            product: { select: { name: true, nameAr: true, cost: true } },
          },
        },
      },
    })

    // ── Aggregate per product (productId groups even when the product row is
    //    gone — fallback name 'Item #<id>', cost 0) ─────────────────────────
    type Agg = {
      productId: number
      name: string
      nameAr: string | null
      cost: number
      soldQtyRaw: number
      revenueRaw: number
      profitRaw: number
    }
    const agg = new Map<number, Agg>()

    for (const order of orders) {
      for (const item of order.items) {
        const key = item.productId ?? 0
        const entry =
          agg.get(key) ??
          ({
            productId: key,
            name: item.product?.name ?? `Item #${key}`,
            nameAr: item.product?.nameAr ?? null,
            cost: item.product?.cost ?? 0,
            soldQtyRaw: 0,
            revenueRaw: 0,
            profitRaw: 0,
          }) satisfies Agg
        // keep the freshest product metadata seen (product rows may differ
        // across soft-delete boundaries; first row wins is fine too)
        if (item.product) {
          entry.name = item.product.name
          entry.nameAr = item.product.nameAr
          entry.cost = item.product.cost
        }
        entry.soldQtyRaw += item.quantity
        entry.revenueRaw += item.quantity * item.unitPrice
        entry.profitRaw += item.quantity * (item.unitPrice - (item.product?.cost ?? 0))
        agg.set(key, entry)
      }
    }

    const totalSoldQty = round2(
      Array.from(agg.values()).reduce((sum, e) => sum + e.soldQtyRaw, 0),
    )

    // ── Per-item stats ─────────────────────────────────────────────────
    let items: MenuItemStat[] = Array.from(agg.values()).map((e) => {
      const soldQty = round2(e.soldQtyRaw)
      const revenue = round2(e.revenueRaw)
      const profit = round2(e.profitRaw)
      const margin = revenue > 0 ? profit / revenue : 0
      const popularity = totalSoldQty > 0 ? soldQty / totalSoldQty : 0
      return {
        productId: e.productId,
        name: e.name,
        nameAr: e.nameAr,
        soldQty,
        revenue,
        profit,
        margin,
        popularity,
        classification: 'dog', // set below once the averages are known
      }
    })

    // ── Kasavana-Smith quadrants vs. the unweighted menu averages ───────
    const count = items.length
    const avgMargin = count > 0 ? items.reduce((s, i) => s + i.margin, 0) / count : 0
    const avgPopularity =
      count > 0 ? items.reduce((s, i) => s + i.popularity, 0) / count : 0

    items = items.map((item) => {
      const popular = item.popularity >= avgPopularity
      const profitable = item.margin >= avgMargin
      const classification: MenuItemStat['classification'] =
        popular && profitable
          ? 'star'
          : popular && !profitable
            ? 'plowhorse'
            : !popular && profitable
              ? 'puzzle'
              : 'dog'
      return { ...item, classification }
    })

    items.sort((a, b) => b.soldQty - a.soldQty)

    const report: MenuEngineeringReport = {
      periodDays: days,
      totalSoldQty,
      // averages stay raw ratios (same scale as each item's margin/popularity)
      avgMargin,
      avgPopularity,
      items,
    }

    return NextResponse.json({ report })
  } catch (err) {
    return errorResponse(err)
  }
}
