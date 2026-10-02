// /api/orders/[id]/defer — defer payment of a check with the client's
// name (waiter/admin). The order moves to status 'deferred' (client pays
// later); its tables switch to 'deferred' (tap-to-clear after cleanup).
//
// R13: the client name is normalized (trimmed, collapsed, Title Case) and
// auto-linked to a Customer profile when one matches the name — deferred
// regulars accrue loyalty when they settle.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { normalizePersonName } from '@/lib/names'
import { deferOrder, parseId, serializeOrder } from '@/lib/orders'

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const user = await requireAuth(req, ['waiter', 'admin', 'pos'])
    const { id } = await ctx.params
    const orderId = parseId(id, 'order id')

    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })
    const clientName = normalizePersonName(String(body?.clientName ?? ''))
    if (clientName.length < 1 || clientName.length > 60) {
      throw new ApiError('Client name is required (1-60 characters)', 400)
    }

    // R13: link a matching customer profile by (normalized) name so the
    // deferred check counts toward loyalty when it settles. Match is
    // never auto-created — only an exact normalized-name hit links.
    if (body?.linkCustomer !== false) {
      const match = await db.customer.findFirst({
        where: { name: clientName, active: true },
        select: { id: true },
      })
      if (match) {
        await db.order
          .updateMany({ where: { id: orderId, customerId: null }, data: { customerId: match.id } })
          .catch(() => undefined) // best-effort — deferring must never block
      }
    }

    const updated = await deferOrder(orderId, clientName)
    const serialized = serializeOrder(updated)

    await logAudit({
      user,
      action: 'order.defer',
      entity: 'order',
      entityId: orderId,
      details: `Check #${orderId} deferred for ${clientName} — EGP ${serialized.remainingAmount.toFixed(
        2,
      )} remaining${serialized.customerId != null ? ` (customer #${serialized.customerId})` : ''}`,
    })

    return NextResponse.json({ order: serialized })
  } catch (err) {
    return errorResponse(err)
  }
}
