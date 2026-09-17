// GET /api/reports/people?from=YYYY-MM-DD&to=YYYY-MM-DD — person-level
// activity statistics (R19). Answers, per user ACCOUNT and per actual
// PERSON: how many checks they issued, how many item moves they performed
// (and how many units), and how many attributed actions they handled.
//
// Sources (NO redundant analytics tables — derived from existing data):
//   · checks       → orders.checkIssuedByPersonId
//   · moves/units  → audit_logs action='order.itemTransfer' + person_id
//                    (units parsed from the standard "<qty>× <name>" summary)
//   · transactions → all audit rows attributed to the person in the window
//
// Response groups accounts by user type (role / custom role name) so the
// admin sees: Waiter → 3 people → per-person counts.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'

/** Parse 'YYYY-MM-DD' into a LOCAL-time Date (null on garbage). */
function parseLocalDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2]) - 1
  const d = Number(m[3])
  const date = new Date(y, mo, d)
  if (date.getFullYear() !== y || date.getMonth() !== mo || date.getDate() !== d) return null
  return date
}

/** Sum the moved units out of an item-transfer audit summary
 *  ("2× Coffee, 1× Tea moved from order #5 to order #8" → 3). */
function unitsFromDetails(details: string | null): number {
  if (!details) return 0
  let units = 0
  // every "<number>× " occurrence is one moved line's quantity
  for (const match of details.matchAll(/(\d+(?:\.\d+)?)×\s/g)) {
    units += Number(match[1])
  }
  return units
}

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['admin', 'users', 'reports'])

    const sp = req.nextUrl.searchParams
    const now = new Date()
    const fromRaw = sp.get('from')
    const toRaw = sp.get('to')
    let fromDay: Date
    if (fromRaw) {
      const parsed = parseLocalDate(fromRaw)
      if (!parsed) throw new ApiError('Invalid from date: expected YYYY-MM-DD', 400)
      fromDay = parsed
    } else {
      fromDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29)
    }
    let toDay: Date
    if (toRaw) {
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
      23, 59, 59, 999,
    )
    if (rangeStart > rangeEnd) {
      throw new ApiError('from date must be before or equal to to date', 400)
    }

    // All accounts + their people (roster), including inactive people so
    // historical counts stay visible (flagged `active: false`).
    const users = await db.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        roleId: true,
        roleRecord: { select: { name: true, active: true } },
        people: { select: { id: true, name: true, active: true } },
      },
      orderBy: { id: 'asc' },
    })

    // Checks issued per person in the window (person-level attribution).
    const checkGroups = await db.order.groupBy({
      by: ['checkIssuedByPersonId'],
      where: {
        checkIssuedByPersonId: { not: null },
        checkIssuedAt: { gte: rangeStart, lte: rangeEnd },
      },
      _count: { id: true },
    })
    const checksByPerson = new Map<number, number>()
    for (const g of checkGroups) {
      if (g.checkIssuedByPersonId != null) checksByPerson.set(g.checkIssuedByPersonId, g._count.id)
    }

    // Attributed audit actions per person in the window.
    const auditRows = await db.auditLog.findMany({
      where: { personId: { not: null }, createdAt: { gte: rangeStart, lte: rangeEnd } },
      select: { personId: true, action: true, details: true },
    })
    const activityByPerson = new Map<number, { transactions: number; moves: number; unitsMoved: number }>()
    for (const row of auditRows) {
      if (row.personId == null) continue
      const agg = activityByPerson.get(row.personId) ?? { transactions: 0, moves: 0, unitsMoved: 0 }
      agg.transactions += 1
      if (row.action === 'order.itemTransfer') {
        agg.moves += 1
        agg.unitsMoved += unitsFromDetails(row.details)
      }
      activityByPerson.set(row.personId, agg)
    }

    // ── Assemble: account groups (user type → people → counts) ─────────
    const groups = users.map((user) => {
      const roleName = user.roleId ? (user.roleRecord?.name ?? null) : null
      const people = user.people.map((person) => {
        const activity = activityByPerson.get(person.id)
        return {
          id: person.id,
          name: person.name,
          active: person.active,
          checks: checksByPerson.get(person.id) ?? 0,
          moves: activity?.moves ?? 0,
          unitsMoved: Math.round((activity?.unitsMoved ?? 0) * 100) / 100,
          transactions: activity?.transactions ?? 0,
        }
      })
      return {
        userId: user.id,
        userName: user.name,
        email: user.email,
        role: user.role,
        roleName,
        people,
        totalPeople: people.filter((p) => p.active).length,
        totals: {
          checks: people.reduce((n, p) => n + p.checks, 0),
          moves: people.reduce((n, p) => n + p.moves, 0),
          unitsMoved: Math.round(people.reduce((n, p) => n + p.unitsMoved, 0) * 100) / 100,
          transactions: people.reduce((n, p) => n + p.transactions, 0),
        },
      }
    })

    // ── By user TYPE (Waiter / Kitchen / Cashier / …) across accounts ───
    const byTypeMap = new Map<string, { type: string; totalPeople: number; checks: number; moves: number; unitsMoved: number; transactions: number }>()
    for (const group of groups) {
      const type =
        group.role === 'custom'
          ? (group.roleName ?? 'Custom')
          : group.role.charAt(0).toUpperCase() + group.role.slice(1)
      const agg = byTypeMap.get(type) ?? { type, totalPeople: 0, checks: 0, moves: 0, unitsMoved: 0, transactions: 0 }
      agg.totalPeople += group.totalPeople
      agg.checks += group.totals.checks
      agg.moves += group.totals.moves
      agg.unitsMoved = Math.round((agg.unitsMoved + group.totals.unitsMoved) * 100) / 100
      agg.transactions += group.totals.transactions
      byTypeMap.set(type, agg)
    }

    return NextResponse.json({
      from: rangeStart.toISOString(),
      to: rangeEnd.toISOString(),
      groups,
      byType: [...byTypeMap.values()].sort((a, b) => b.totalPeople - a.totalPeople),
    })
  } catch (err) {
    return errorResponse(err)
  }
}
