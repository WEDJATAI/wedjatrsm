// /api/customers/stats — R29 CRM insight header.
// GET (any authenticated staff): one aggregate query feeding the KPI row —
// active / VIP (gold+diamond spend) / at-risk (visited but 30+ days silent) /
// new (joined within 30 days) / inactive, tracked revenue, points pool and
// the full tier breakdown. Tiers are the SAME engine the UI uses
// (src/lib/person-style.ts) so the numbers can never disagree.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { errorResponse, requireAuth } from '@/lib/auth'
import { CUSTOMER_TIERS, isVipTier, tierOf } from '@/lib/person-style'

/** A customer has lapsed when their last visit is 30+ days old. */
export const AT_RISK_DAYS = 30

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req)

    const customers = await db.customer.findMany({
      select: {
        active: true,
        visits: true,
        points: true,
        totalSpent: true,
        lastVisitAt: true,
        createdAt: true,
      },
    })

    const active = customers.filter((c) => c.active)
    const atRiskCutoff = daysAgo(AT_RISK_DAYS)

    const tierCounts: Record<string, number> = {}
    for (const tier of CUSTOMER_TIERS) tierCounts[tier.key] = 0

    let vip = 0
    let atRisk = 0
    let newThisMonth = 0
    let trackedRevenue = 0
    let totalPoints = 0
    let visitsTotal = 0

    for (const c of active) {
      const tier = tierOf(c.totalSpent)
      tierCounts[tier.key] += 1
      if (isVipTier(tier)) vip += 1
      // at-risk: has dined with us before but has been silent 30+ days
      if (c.visits > 0 && c.lastVisitAt != null && c.lastVisitAt < atRiskCutoff) atRisk += 1
      if (c.createdAt > daysAgo(30)) newThisMonth += 1
      trackedRevenue += c.totalSpent
      totalPoints += c.points
      visitsTotal += c.visits
    }

    return NextResponse.json({
      stats: {
        totalActive: active.length,
        inactive: customers.length - active.length,
        vip,
        atRisk,
        atRiskDays: AT_RISK_DAYS,
        newThisMonth,
        trackedRevenue: round2(trackedRevenue),
        totalPoints: Math.round(totalPoints * 100) / 100,
        avgSpendPerVisit: visitsTotal > 0 ? round2(trackedRevenue / visitsTotal) : 0,
        tierCounts,
      },
    })
  } catch (err) {
    return errorResponse(err)
  }
}
