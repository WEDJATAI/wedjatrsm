// /api/reports/my-shift — per-server shift closeout (R8).
// "My shift": today's sales, collected amounts and TIPS for the SESSION user
// (waiter-accessible — unlike /api/reports/* which is admin/reports gated).
// "Today" runs from the SERVER's local midnight, mirroring the Z-report's
// day boundary. Optional ?userId=<id> targets another server but is
// admin-only (everyone else gets 403).
//
// Orders considered: created by the user today with status in
// ('open','paid','deferred') — cancelled checks and merged-away sources are
// excluded. Tips are attributed from the payment rows on those orders.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { round2, sessionUserId } from '@/lib/orders'
import type { MyShiftReport } from '@/lib/types'

export async function GET(req: NextRequest) {
  try {
    // Any authenticated user — waiters are the primary audience. No role
    // restriction (the base session variant of the auth guard).
    const session = await requireAuth(req)
    const meId = sessionUserId(session)

    // Optional cross-user lookup, admins only.
    const sp = new URL(req.url).searchParams
    const userIdRaw = sp.get('userId')
    let userId = meId
    let userName = session.name
    if (userIdRaw !== null && userIdRaw !== '') {
      const requested = Number(userIdRaw)
      if (!Number.isInteger(requested) || requested <= 0) {
        throw new ApiError('Invalid userId', 400)
      }
      if (session.role !== 'admin' && requested !== meId) {
        throw new ApiError('Forbidden: only admins can view another server', 403)
      }
      if (requested !== meId) {
        const row = await db.user.findUnique({
          where: { id: requested },
          select: { name: true },
        })
        if (!row) throw new ApiError('User not found', 404)
        userName = row.name
      }
      userId = requested
    }

    // Local server midnight → now (same day window as the Z-report).
    const now = new Date()
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())

    const orders = await db.order.findMany({
      where: {
        userId,
        createdAt: { gte: dayStart },
        status: { in: ['open', 'paid', 'deferred'] },
      },
      select: {
        status: true,
        totalAmount: true,
        payments: { select: { method: true, amount: true, tip: true } },
      },
      orderBy: { createdAt: 'asc' },
    })

    let salesTotalRaw = 0
    let paidTotalRaw = 0
    let paidOrdersCount = 0
    let openChecksCount = 0
    let openValueRaw = 0
    let tipsTotalRaw = 0
    const methodAgg = new Map<string, { amount: number; count: number; tip: number }>()

    for (const order of orders) {
      salesTotalRaw += order.totalAmount
      if (order.status === 'paid') {
        paidTotalRaw += order.totalAmount
        paidOrdersCount += 1
      } else {
        // open + deferred checks still outstanding (payments may exist)
        openChecksCount += 1
        const paid = order.payments.reduce((sum, p) => sum + p.amount, 0)
        openValueRaw += Math.max(0, order.totalAmount - paid)
      }
      // Tips come from ALL payment rows on those orders (open orders with
      // partial payments, deferred checks, fully paid checks alike).
      for (const payment of order.payments) {
        const tip = payment.tip ?? 0
        tipsTotalRaw += tip
        const agg = methodAgg.get(payment.method) ?? { amount: 0, count: 0, tip: 0 }
        agg.amount += payment.amount
        agg.count += 1
        agg.tip += tip
        methodAgg.set(payment.method, agg)
      }
    }

    const ordersCount = orders.length

    const report: MyShiftReport = {
      userId,
      userName,
      salesTotal: round2(salesTotalRaw),
      paidTotal: round2(paidTotalRaw),
      ordersCount,
      paidOrdersCount,
      openChecksCount,
      openValue: round2(openValueRaw),
      tipsTotal: round2(tipsTotalRaw),
      avgCheck: ordersCount > 0 ? round2(salesTotalRaw / ordersCount) : 0,
      byMethod: Array.from(methodAgg.entries())
        .map(([method, v]) => ({
          method,
          amount: round2(v.amount),
          count: v.count,
          tip: round2(v.tip),
        }))
        .sort((a, b) => b.amount - a.amount),
    }

    return NextResponse.json({ report })
  } catch (err) {
    return errorResponse(err)
  }
}
