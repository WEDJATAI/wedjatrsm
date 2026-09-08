// /api/cash-drawer — cash drawer session management (R8)
// GET  → { status: CashDrawerStatus }  (active session + live expected math +
//        last 10 closed sessions) — permission 'cashdrawer'
// POST → { action: 'open', openingFloat } | { action: 'paid_in'|'paid_out', amount, note? }
// Expected cash = openingFloat + cash sales + cash tips (payments with method
// 'cash' created inside the session window) + paid-ins − paid-outs, round2.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import type { SessionPayload } from '@/lib/auth'
import { round2 } from '@/lib/orders'
import type {
  CashDrawerEntryDTO,
  CashDrawerSessionDTO,
  CashDrawerStatus,
} from '@/lib/types'

const NOTE_MAX = 200
const RECENT_SESSIONS_LIMIT = 10

type EntryRow = {
  id: number
  sessionId: number
  type: string
  amount: number
  note: string | null
  userId: number | null
  createdAt: Date
  user?: { id: number; name: string } | null
}

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
  entries?: EntryRow[]
}

/** CashDrawerEntry row → DTO (dates ISO, money round2). */
function serializeEntry(row: EntryRow): CashDrawerEntryDTO {
  return {
    id: row.id,
    sessionId: row.sessionId,
    type: row.type,
    amount: round2(row.amount),
    note: row.note,
    userId: row.userId,
    user: row.user ? { id: row.user.id, name: row.user.name } : null,
    createdAt: row.createdAt.toISOString(),
  }
}

/** CashDrawerSession row → DTO (entries optional, dates ISO, money round2). */
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
    entries: row.entries ? row.entries.map(serializeEntry) : undefined,
  }
}

/**
 * Live expected-cash math for an OPEN session. Window [openedAt, now]:
 * openingFloat + cash sales + cash tips + paid-ins − paid-outs, round2.
 * KEEP IN SYNC with the identical helper in [id]/route.ts (route files may
 * only export handlers, so the logic is duplicated in both routes).
 */
async function computeExpected(
  session: Pick<SessionRow, 'id' | 'openingFloat' | 'openedAt'>,
): Promise<{
  openingFloat: number
  cashSales: number
  cashTips: number
  paidIn: number
  paidOut: number
  total: number
}> {
  const now = new Date()
  // cash payments (amount + tip on top) received while the drawer is open
  const cashPayments = await db.payment.aggregate({
    where: { method: 'cash', createdAt: { gte: session.openedAt, lte: now } },
    _sum: { amount: true, tip: true },
  })
  // manual entries recorded on this session
  const entries = await db.cashDrawerEntry.findMany({
    where: { sessionId: session.id },
    select: { type: true, amount: true },
  })

  const openingFloat = round2(session.openingFloat)
  const cashSales = round2(cashPayments._sum.amount ?? 0)
  const cashTips = round2(cashPayments._sum.tip ?? 0)
  const paidIn = round2(
    entries.filter((e) => e.type === 'paid_in').reduce((sum, e) => sum + e.amount, 0),
  )
  const paidOut = round2(
    entries.filter((e) => e.type === 'paid_out').reduce((sum, e) => sum + e.amount, 0),
  )
  const total = round2(openingFloat + cashSales + cashTips + paidIn - paidOut)
  return { openingFloat, cashSales, cashTips, paidIn, paidOut, total }
}

/**
 * Fire-and-forget audit row. 'drawer.*' actions are not in lib/audit's
 * AUDIT_ACTIONS union and that file is outside this route's ownership →
 * written directly (same shape as logAudit, entity 'settings').
 */
async function auditDrawer(
  user: SessionPayload,
  action: 'drawer.open' | 'drawer.paid_in' | 'drawer.paid_out' | 'drawer.close',
  entityId: number | null,
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

/**
 * The single open (closedAt = null) session with entry user names
 * (CashDrawerEntry has NO User relation — plain userId FK — so names are
 * resolved with a second lookup), or null.
 */
async function findOpenSession(): Promise<SessionRow | null> {
  const session = await db.cashDrawerSession.findFirst({
    where: { closedAt: null },
    orderBy: { openedAt: 'desc' },
    include: {
      user: { select: { id: true, name: true } },
      entries: { orderBy: { createdAt: 'asc' } },
    },
  })
  if (!session) return null
  const userIds = Array.from(
    new Set(
      session.entries
        .map((e) => e.userId)
        .filter((x): x is number => x != null),
    ),
  )
  const users =
    userIds.length > 0
      ? await db.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true },
        })
      : []
  const userMap = new Map(users.map((u) => [u.id, { id: u.id, name: u.name }]))
  return {
    ...session,
    entries: session.entries.map((e) => ({
      ...e,
      user: e.userId != null ? (userMap.get(e.userId) ?? null) : null,
    })),
  }
}

/** Parse + validate an optional note (trimmed, length cap). */
function parseNote(value: unknown, max: number, label: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new ApiError(`${label} must be a string`, 400)
  const trimmed = value.trim()
  if (trimmed.length > max) {
    throw new ApiError(`${label} must be at most ${max} characters`, 400)
  }
  return trimmed === '' ? null : trimmed
}

// ─── GET: drawer status (active + expected + recent closed sessions) ──

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['cashdrawer'])

    const [activeRow, recentRows] = await Promise.all([
      findOpenSession(),
      db.cashDrawerSession.findMany({
        where: { closedAt: { not: null } },
        orderBy: { closedAt: 'desc' },
        take: RECENT_SESSIONS_LIMIT,
        include: { user: { select: { id: true, name: true } } },
      }),
    ])

    const expected = activeRow ? await computeExpected(activeRow) : null
    const status: CashDrawerStatus = {
      active: activeRow ? serializeSession(activeRow) : null,
      expected,
      recentSessions: recentRows.map(serializeSession),
    }
    return NextResponse.json({ status })
  } catch (err) {
    return errorResponse(err)
  }
}

// ─── POST: open a session / record a paid-in or paid-out ──────────────

export async function POST(req: NextRequest) {
  try {
    const user = await requireAuth(req, ['cashdrawer'])

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    const action = typeof body.action === 'string' ? body.action : ''

    if (action === 'open') {
      const open = await findOpenSession()
      if (open) throw new ApiError('A drawer session is already open', 400)

      const floatRaw = body.openingFloat
      if (floatRaw === undefined || floatRaw === null || floatRaw === '') {
        throw new ApiError('Opening float is required', 400)
      }
      const float = Number(floatRaw)
      if (!Number.isFinite(float) || float < 0) {
        throw new ApiError('Opening float must be a number ≥ 0', 400)
      }
      const openingFloat = round2(float)

      const created = await db.cashDrawerSession.create({
        data: { userId: user.userId, openingFloat },
        include: { user: { select: { id: true, name: true } } },
      })
      await auditDrawer(
        user,
        'drawer.open',
        created.id,
        `Cash drawer opened (float EGP ${openingFloat.toFixed(2)})`,
      )
      return NextResponse.json({ session: serializeSession(created) }, { status: 201 })
    }

    if (action === 'paid_in' || action === 'paid_out') {
      const type = action
      const open = await findOpenSession()
      if (!open) throw new ApiError('No open drawer session', 400)

      const amountRaw = body.amount
      const amount = Number(amountRaw)
      if (
        amountRaw === undefined ||
        amountRaw === null ||
        amountRaw === '' ||
        !Number.isFinite(amount) ||
        amount <= 0
      ) {
        throw new ApiError('Enter an amount', 400)
      }
      const note = parseNote(body.note, NOTE_MAX, 'Note')

      const amountR = round2(amount)
      const entry = await db.cashDrawerEntry.create({
        data: {
          sessionId: open.id,
          type,
          amount: amountR,
          note,
          userId: user.userId,
        },
      })
      const entryDto: CashDrawerEntryDTO = {
        id: entry.id,
        sessionId: entry.sessionId,
        type: entry.type,
        amount: round2(entry.amount),
        note: entry.note,
        userId: entry.userId,
        user: { id: user.userId, name: user.name },
        createdAt: entry.createdAt.toISOString(),
      }
      await auditDrawer(
        user,
        type === 'paid_in' ? 'drawer.paid_in' : 'drawer.paid_out',
        open.id,
        `Cash drawer ${type === 'paid_in' ? 'paid in' : 'paid out'} EGP ${amountR.toFixed(2)}${note ? ` — ${note}` : ''}`,
      )
      return NextResponse.json({ entry: entryDto }, { status: 201 })
    }

    throw new ApiError("action must be 'open', 'paid_in' or 'paid_out'", 400)
  } catch (err) {
    return errorResponse(err)
  }
}
