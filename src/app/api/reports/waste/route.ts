// /api/reports/waste — waste report (Foodics Waste analytics). Aggregates
// WasteLog entries in a local-time date window (default: last 30 days):
// total value, entries, a per-reason breakdown (ALL 6 reasons always
// present, zeroed when absent) and the top 5 wasted items by value.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, errorResponse, ApiError } from '@/lib/auth'
import { WASTE_REASONS } from '@/lib/constants'
import type { WasteReport } from '@/lib/types'

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
    await requireAuth(req, ['admin', 'reports', 'inventory'])

    const sp = new URL(req.url).searchParams
    const fromRaw = sp.get('from')
    const toRaw = sp.get('to')

    let start: Date
    let end: Date
    if (fromRaw !== null && fromRaw !== '') {
      const parsed = parseLocalDate(fromRaw)
      if (!parsed) throw new ApiError('Invalid from date: expected YYYY-MM-DD', 400)
      start = parsed
    } else {
      const now = new Date()
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30)
    }
    if (toRaw !== null && toRaw !== '') {
      const parsed = parseLocalDate(toRaw)
      if (!parsed) throw new ApiError('Invalid to date: expected YYYY-MM-DD', 400)
      end = new Date(parsed.getTime() + 24 * 60 * 60 * 1000) // inclusive day
    } else {
      const now = new Date()
      end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    }

    const entries = await db.wasteLog.findMany({
      where: { createdAt: { gte: start, lt: end } },
      select: {
        productId: true,
        quantity: true,
        costValue: true,
        reason: true,
        product: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    })

    const reasonAgg = new Map<string, { quantity: number; value: number; entries: number }>()
    const itemAgg = new Map<number, { name: string; quantity: number; value: number }>()
    let totalValueRaw = 0

    for (const entry of entries) {
      totalValueRaw += entry.costValue

      const reason = reasonAgg.get(entry.reason) ?? { quantity: 0, value: 0, entries: 0 }
      reason.quantity += entry.quantity
      reason.value += entry.costValue
      reason.entries += 1
      reasonAgg.set(entry.reason, reason)

      const item =
        itemAgg.get(entry.productId) ?? {
          name: entry.product?.name ?? `#${entry.productId}`,
          quantity: 0,
          value: 0,
        }
      item.quantity += entry.quantity
      item.value += entry.costValue
      itemAgg.set(entry.productId, item)
    }

    // Every reason always present (zeroed when absent), in canonical order.
    const byReason = WASTE_REASONS.map((reason) => {
      const agg = reasonAgg.get(reason)
      return {
        reason,
        quantity: round2(agg?.quantity ?? 0),
        value: round2(agg?.value ?? 0),
        entries: agg?.entries ?? 0,
      }
    })

    const topItems = Array.from(itemAgg.entries())
      .map(([productId, v]) => ({
        productId,
        name: v.name,
        quantity: round2(v.quantity),
        value: round2(v.value),
      }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 5)

    const report: WasteReport = {
      from: formatLocalDate(start),
      to: formatLocalDate(new Date(end.getTime() - 24 * 60 * 60 * 1000)),
      totalValue: round2(totalValueRaw),
      entries: entries.length,
      byReason,
      topItems,
    }

    return NextResponse.json({ report })
  } catch (err) {
    return errorResponse(err)
  }
}
