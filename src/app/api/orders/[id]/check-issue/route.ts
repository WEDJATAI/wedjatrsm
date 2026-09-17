// POST /api/orders/[id]/check-issue — stamp who presented/issued the guest
// check (R19). The person comes from the CURRENT session context (never
// typed manually): the session's selected person, falling back to the
// account name when no person is registered.
//   · First issuance wins: checkIssuedByPersonId/checkIssuedAt are stamped
//     only when null, so re-prints never rewrite history.
//   · Every call is audited (order.checkIssue), including re-presentations.
// Idempotent, safe to call from the check modal on print/present.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { parseId } from '@/lib/orders'

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const user = await requireAuth(req, ['waiter', 'admin', 'pos'])
    const { id } = await ctx.params
    const orderId = parseId(id, 'order id')

    const order = await db.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true, checkIssuedByPersonId: true, checkIssuedAt: true },
    })
    if (!order) throw new ApiError('Order not found', 404)
    // A paid/cancelled order's check was already issued — nothing to stamp,
    // but the presentation itself is still audited below.
    if (order.status === 'cancelled') {
      throw new ApiError('Cannot issue a check on a cancelled order', 400)
    }

    const personId = user.personId
    const personName = user.personName ?? user.name

    let stamped = false
    if (order.checkIssuedByPersonId == null && personId != null) {
      // First presentation — stamp the responsible PERSON + timestamp.
      // Only person-level sessions stamp (an account-level session keeps
      // the account fallback on the paper instead of burning the first
      // stamp with no person attached).
      // Conditional update: only when still null (two waiters presenting
      // simultaneously → the first stamp wins, no double overwrite).
      const updated = await db.order.updateMany({
        where: { id: orderId, checkIssuedByPersonId: null },
        data: {
          checkIssuedByPersonId: personId,
          checkIssuedAt: new Date(),
        },
      })
      stamped = updated.count === 1
    }

    await logAudit({
      user,
      action: 'order.checkIssue',
      entity: 'order',
      entityId: orderId,
      details: `Check ${stamped ? 'issued' : 'presented'} by ${personName}` +
        (personId != null ? ` (person #${personId})` : ' (account level)'),
    })

    const fresh = await db.order.findUnique({
      where: { id: orderId },
      select: {
        checkIssuedAt: true,
        checkIssuedByPerson: { select: { id: true, name: true } },
      },
    })
    return NextResponse.json({
      stamped,
      checkIssuedBy: fresh?.checkIssuedByPerson ?? null,
      checkIssuedAt: fresh?.checkIssuedAt ? fresh.checkIssuedAt.toISOString() : null,
    })
  } catch (err) {
    return errorResponse(err)
  }
}
