// /api/cash-drawer/[id] — close a cash drawer session (R8)
// POST { action: 'close', countedCash, note? } → { session: CashDrawerSessionDTO }
// Expected cash is recomputed EXACTLY like GET /api/cash-drawer (window
// [openedAt, now]) at close time and persisted with the counted amount and
// variance (counted − expected), all round2.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import type { SessionPayload } from '@/lib/auth'
import { round2 } from '@/lib/orders'
import type { CashDrawerSessionDTO } from '@/lib/types'

const NOTE_MAX = 300

type SessionRow = {
  id: number
  userId: number
  user?: { id: number; name: string } | null
  openingFloat: number
  openedAt: Date
  closedAt: Date | null
  countedCash: number | null
  expectedCash: number | null
  variance: number | null
  note: string | null
}

/** CashDrawerSession row → DTO (dates ISO, money round2). */
function serializeSession(row: SessionRow): CashDrawerSessionDTO {
  return {
    id: row.id,
    user: row.user ? { id: row.user.id, name: row.user.name } : null,
    openingFloat: round2(row.openingFloat),
    openedAt: row.openedAt.toISOString(),
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    countedCash: row.countedCash == null ? null : round2(row.countedCash),
    expectedCash: row.expectedCash == null ? null : round2(row.expectedCash),
    variance: row.variance == null ? null : round2(row.variance),
    note: row.note,
    entries: undefined,
  }
}

/**
 * Expected cash at close time — identical math to GET /api/cash-drawer
 * (window [openedAt, now]): openingFloat + cash sales + cash tips +
 * paid-ins − paid-outs, round2. KEEP IN SYNC with the sibling route
 * (route files may only export handlers, hence the duplication).
 */
async function computeExpected(
  session: Pick<SessionRow, 'id' | 'openingFloat' | 'openedAt'>,
): Promise<number> {
  const now = new Date()
  const cashPayments = await db.payment.aggregate({
    where: { method: 'cash', createdAt: { gte: session.openedAt, lte: now } },
    _sum: { amount: true, tip: true },
  })
  const entries = await db.cashDrawerEntry.findMany({
    where: { sessionId: session.id },
    select: { type: true, amount: true },
  })
  const cashSales = cashPayments._sum.amount ?? 0
  const cashTips = cashPayments._sum.tip ?? 0
  const paidIn = entries
    .filter((e) => e.type === 'paid_in')
    .reduce((sum, e) => sum + e.amount, 0)
  const paidOut = entries
    .filter((e) => e.type === 'paid_out')
    .reduce((sum, e) => sum + e.amount, 0)
  return round2(session.openingFloat + cashSales + cashTips + paidIn - paidOut)
}

/** Fire-and-forget audit row ('drawer.*' is not in lib/audit's union and
 *  that file is outside this route's ownership → direct write, entity 'settings'). */
async function auditDrawer(
  user: SessionPayload,
  action: 'drawer.close',
  entityId: number,
  details: string,
): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        userId: user.userId,
        userName: user.name,
        action,
        entity: 'settings',
        entityId,
        details,
      },
    })
  } catch (err) {
    console.error('[audit-log] failed to record', action, err)
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireAuth(req, ['cashdrawer'])
    const { id } = await params

    const sessionId = Number(id)
    if (!Number.isInteger(sessionId) || sessionId <= 0) {
      throw new ApiError('Invalid session id', 400)
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const action = typeof body.action === 'string' ? body.action : ''
    if (action !== 'close') throw new ApiError("action must be 'close'", 400)

    const session = await db.cashDrawerSession.findUnique({
      where: { id: sessionId },
      include: { user: { select: { id: true, name: true } } },
    })
    if (!session) throw new ApiError('Drawer session not found', 404)
    if (session.closedAt !== null) {
      throw new ApiError('Drawer session is already closed', 400)
    }

    const countedRaw = body.countedCash
    if (countedRaw === undefined || countedRaw === null || countedRaw === '') {
      throw new ApiError('Counted cash is required', 400)
    }
    const counted = Number(countedRaw)
    if (!Number.isFinite(counted) || counted < 0) {
      throw new ApiError('Counted cash must be a number ≥ 0', 400)
    }
    const countedCash = round2(counted)

    let note: string | null = null
    if (body.note !== undefined && body.note !== null) {
      if (typeof body.note !== 'string') throw new ApiError('Note must be a string', 400)
      note = body.note.trim()
      if (note.length > NOTE_MAX) {
        throw new ApiError(`Note must be at most ${NOTE_MAX} characters`, 400)
      }
      if (note === '') note = null
    }

    // expected computed EXACTLY like GET /api/cash-drawer, then persisted
    const expected = await computeExpected(session)
    const variance = round2(countedCash - expected)
    const closedAt = new Date()

    const updated = await db.cashDrawerSession.update({
      where: { id: sessionId },
      data: { countedCash, expectedCash: expected, variance, note, closedAt },
      include: { user: { select: { id: true, name: true } } },
    })

    await auditDrawer(
      user,
      'drawer.close',
      sessionId,
      `Cash drawer closed — expected EGP ${expected.toFixed(2)}, counted EGP ${countedCash.toFixed(2)}, variance EGP ${variance.toFixed(2)}`,
    )

    return NextResponse.json({ session: serializeSession(updated) })
  } catch (err) {
    return errorResponse(err)
  }
}
