import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, errorResponse, ApiError } from '@/lib/auth'
import type { SalesReport } from '@/lib/types'

const round2 = (n: number): number => Math.round(n * 100) / 100

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Parse 'YYYY-MM-DD' into a LOCAL-time Date (avoids the UTC shift of new Date(str)); null on garbage. */
function parseLocalDate(s: string): Date | null {
  const m = DATE_RE.exec(s)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const dt = new Date(y, mo - 1, d)
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null
  return dt
}

/** Format a Date as a LOCAL 'YYYY-MM-DD' string. */
function formatLocalDate(d: Date): string {
  const y = d.getFullYear()
  const mo = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${y}-${mo}-${dd}`
}

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['admin'])

    const sp = new URL(req.url).searchParams
    const fromRaw = sp.get('from')
    const toRaw = sp.get('to')

    const now = new Date()

    let fromDay: Date
    if (fromRaw !== null && fromRaw !== '') {
      const parsed = parseLocalDate(fromRaw)
      if (!parsed) throw new ApiError('Invalid from date: expected YYYY-MM-DD', 400)
      fromDay = parsed
    } else {
      // default: 30 days ago
      fromDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30)
    }

    let toDay: Date
    if (toRaw !== null && toRaw !== '') {
      const parsed = parseLocalDate(toRaw)
      if (!parsed) throw new ApiError('Invalid to date: expected YYYY-MM-DD', 400)
      toDay = parsed
    } else {
      toDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    }

    const rangeStart = new Date(fromDay.getFullYear(), fromDay.getMonth(), fromDay.getDate())
    const rangeEnd = new Date(
      toDay.getFullYear(),
      toDay.getMonth(),
      toDay.getDate(),
      23, 59, 59, 999, // 'to' is inclusive → end of day
    )
    if (rangeStart.getTime() > rangeEnd.getTime()) {
      throw new ApiError('from date must be before or equal to to date', 400)
    }

    const orders = await db.order.findMany({
      where: { status: 'paid', createdAt: { gte: rangeStart, lte: rangeEnd } },
      include: {
        items: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                categoryId: true,
                category: { select: { id: true, name: true } },
              },
            },
          },
        },
        payments: { select: { method: true, amount: true } },
      },
      orderBy: { createdAt: 'asc' },
    })

    // ── Aggregate in JS ────────────────────────────────────────────────
    let totalRevenueRaw = 0
    const methodAgg = new Map<string, { amount: number; count: number }>()
    const productAgg = new Map<number, { productId: number; name: string; quantity: number; revenue: number }>()
    const categoryAgg = new Map<
      number | null,
      { categoryId: number | null; name: string; revenue: number; quantity: number }
    >()
    const dayAgg = new Map<string, { revenue: number; orders: number }>()
    const hourAgg = new Map<number, { revenue: number; orders: number }>()

    for (const order of orders) {
      totalRevenueRaw += order.totalAmount

      const dayKey = formatLocalDate(order.createdAt)
      const day = dayAgg.get(dayKey) ?? { revenue: 0, orders: 0 }
      day.revenue += order.totalAmount
      day.orders += 1
      dayAgg.set(dayKey, day)

      const hour = order.createdAt.getHours()
      const hr = hourAgg.get(hour) ?? { revenue: 0, orders: 0 }
      hr.revenue += order.totalAmount
      hr.orders += 1
      hourAgg.set(hour, hr)

      for (const payment of order.payments) {
        const pay = methodAgg.get(payment.method) ?? { amount: 0, count: 0 }
        pay.amount += payment.amount
        pay.count += 1
        methodAgg.set(payment.method, pay)
      }

      for (const item of order.items) {
        const product = item.product
        if (!product) continue // item whose product was deleted
        const lineRevenue = item.quantity * item.unitPrice

        const prod = productAgg.get(product.id) ?? {
          productId: product.id,
          name: product.name,
          quantity: 0,
          revenue: 0,
        }
        prod.quantity += item.quantity
        prod.revenue += lineRevenue
        productAgg.set(product.id, prod)

        const cat = categoryAgg.get(product.categoryId) ?? {
          categoryId: product.categoryId,
          name: product.category?.name ?? 'Uncategorized',
          revenue: 0,
          quantity: 0,
        }
        cat.revenue += lineRevenue
        cat.quantity += item.quantity
        categoryAgg.set(product.categoryId, cat)
      }
    }

    const totalRevenue = round2(totalRevenueRaw)
    const totalOrders = orders.length
    const avgOrderValue = totalOrders > 0 ? round2(totalRevenue / totalOrders) : 0

    const byMethod = Array.from(methodAgg.entries())
      .map(([method, v]) => ({ method, amount: round2(v.amount), count: v.count }))
      .sort((a, b) => b.amount - a.amount)

    const topProducts = Array.from(productAgg.values())
      .map((v) => ({ ...v, quantity: round2(v.quantity), revenue: round2(v.revenue) }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 8)

    const byCategory = Array.from(categoryAgg.values())
      .map((v) => ({ ...v, quantity: round2(v.quantity), revenue: round2(v.revenue) }))
      .sort((a, b) => b.revenue - a.revenue)

    // Zero-filled continuous day series (local dates) for charts.
    const byDay: SalesReport['byDay'] = []
    const cursor = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate())
    const lastDay = new Date(toDay.getFullYear(), toDay.getMonth(), toDay.getDate())
    while (cursor.getTime() <= lastDay.getTime()) {
      const key = formatLocalDate(cursor)
      const agg = dayAgg.get(key) ?? { revenue: 0, orders: 0 }
      byDay.push({ date: key, revenue: round2(agg.revenue), orders: agg.orders })
      cursor.setDate(cursor.getDate() + 1)
    }

    // Zero-filled 24-hour series.
    const byHour: SalesReport['byHour'] = []
    for (let h = 0; h < 24; h++) {
      const agg = hourAgg.get(h) ?? { revenue: 0, orders: 0 }
      byHour.push({ hour: h, revenue: round2(agg.revenue), orders: agg.orders })
    }

    const report: SalesReport = {
      totalRevenue,
      totalOrders,
      avgOrderValue,
      byMethod,
      topProducts,
      byCategory,
      byDay,
      byHour,
    }

    return NextResponse.json(report)
  } catch (err) {
    return errorResponse(err)
  }
}
