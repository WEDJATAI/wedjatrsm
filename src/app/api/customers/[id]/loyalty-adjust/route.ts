// /api/customers/[id]/loyalty-adjust — manual points correction (R12, 12-a)
//
// POST (admin): { points: non-zero integer (±), note? }
//   → { customer, transaction }
// The new balance is kept ≥ 0 (an overdraft attempt is a 400). The move is
// written as an immutable LoyaltyTransaction (kind 'adjust') in the SAME
// transaction as the customer balance update, and audited as
// 'customer.loyaltyAdjust' with `±N → balance X (note)`.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { parseId } from '@/lib/orders'
import { logCustomerAudit, serializeCustomer, serializeLoyalty } from '../../customer-helpers'

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, ctx: Ctx) {
  try {
    const user = await requireAuth(req, ['admin'])
    const { id } = await ctx.params
    const customerId = parseId(id, 'customer id')

    const existing = await db.customer.findUnique({
      where: { id: customerId },
      select: { id: true, name: true, loyaltyPoints: true },
    })
    if (!existing) throw new ApiError('Customer not found', 404)

    let body: Record<string, unknown> = {}
    try {
      const parsed: unknown = await req.json()
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>
      }
    } catch {
      // fall through — invalid/empty JSON is treated as an empty body
    }

    const points = Number(body.points)
    if (!Number.isInteger(points) || points === 0) {
      throw new ApiError('points must be a non-zero integer', 400)
    }
    const note = body.note == null ? null : String(body.note).trim()
    if (note != null && note.length > 200) {
      throw new ApiError('Note must be at most 200 characters', 400)
    }

    const newBalance = existing.loyaltyPoints + points
    if (newBalance < 0) {
      throw new ApiError('Insufficient points', 400)
    }

    const { customer, transaction } = await db.$transaction(async (tx) => {
      const customer = await tx.customer.update({
        where: { id: customerId },
        data: { loyaltyPoints: { increment: points } },
      })
      const transaction = await tx.loyaltyTransaction.create({
        data: {
          customerId,
          points,
          kind: 'adjust',
          note: note && note.length > 0 ? note : null,
        },
      })
      return { customer, transaction }
    })

    await logCustomerAudit(
      user,
      'customer.loyaltyAdjust',
      customerId,
      `${points > 0 ? '+' : ''}${points} → balance ${customer.loyaltyPoints}${
        transaction.note ? ` (${transaction.note})` : ''
      }`,
    )

    return NextResponse.json({
      customer: serializeCustomer(customer),
      transaction: serializeLoyalty(transaction),
    })
  } catch (err) {
    return errorResponse(err)
  }
}
