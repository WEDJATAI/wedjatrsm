// /api/deductions/[id] — r65: remove a manual salary deduction (correction).
// Gate: manager (admin/developer/super admin) or a 'deductions'-permission
// holder. The delete rides the hybrid outbox so every plane converges.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, errorResponse, ApiError } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { emitOutboxEvent } from '@/lib/hybrid-sync/outbox'

type Ctx = { params: Promise<{ id: string }> }

export async function DELETE(req: NextRequest, ctx: Ctx) {
  try {
    const session = await requireAuth(req, ['admin', 'deductions'])
    const { id } = await ctx.params
    const deductionId = Number(id)
    if (!Number.isInteger(deductionId) || deductionId <= 0) {
      throw new ApiError('Invalid deduction id', 400)
    }

    const existing = await db.salaryDeduction.findUnique({
      where: { id: deductionId },
      include: { user: { select: { id: true, name: true, email: true } } },
    })
    if (!existing) throw new ApiError('Deduction not found', 404)

    // R30 hybrid sync: pre-delete snapshot rides the outbox atomically
    await db.$transaction(async (tx) => {
      await tx.salaryDeduction.delete({ where: { id: deductionId } })
      await emitOutboxEvent(tx, {
        entity: 'SalaryDeduction',
        entityId: deductionId,
        operation: 'delete',
        row: existing,
      })
    })

    await logAudit({
      user: session,
      action: 'deduction.delete',
      entity: 'payroll',
      entityId: deductionId,
      details: `Removed deduction EGP ${existing.amount.toFixed(2)} for ${existing.user.name} (${existing.user.email}) — ${existing.periodMonth}${existing.reason ? ` — was: ${existing.reason}` : ''}`,
    })

    return NextResponse.json({ ok: true, id: deductionId })
  } catch (err) {
    return errorResponse(err)
  }
}
