import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth, type SessionPayload } from '@/lib/auth'

// ── R11: drag-sort persistence for products ───────────────────────────
// PUT { orderedIds: number[] } → displayOrder = index for every existing
// id (unknown ids are ignored but still consume their index). The dense
// 0..n-1 sequence is the single global menu order surfaced by
// GET /api/products (orderBy displayOrder asc, name asc).

const MAX_IDS = 500

async function readBody(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await req.json()
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // fall through — invalid/empty JSON is treated as an empty body
  }
  return {}
}

// Local audit writer — lib/audit.ts action/entity unions are frozen
// (foundation-owned); the AuditLog columns are plain strings, so this
// mirrors logAudit's fire-and-forget semantics for 'products.reorder'.
async function logAuditEntry(input: {
  user?: Pick<SessionPayload, 'userId' | 'name'> | null
  action: string
  entity: string
  entityId?: number | null
  details?: string | null
}): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        userId: input.user?.userId ?? null,
        userName: input.user?.name ?? 'system',
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? null,
        details: input.details ?? null,
      },
    })
  } catch (err) {
    console.error('[audit-log] failed to record', input.action, err)
  }
}

export async function PUT(req: NextRequest) {
  try {
    const user = await requireAuth(req, ['admin', 'products'])
    const body = await readBody(req)

    const raw = body.orderedIds
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new ApiError('orderedIds must be a non-empty array of product ids', 400)
    }
    if (raw.length > MAX_IDS) {
      throw new ApiError(`orderedIds supports at most ${MAX_IDS} items`, 400)
    }

    // Validate + dedupe (first occurrence wins — a duplicated id cannot
    // occupy two positions).
    const ids: number[] = []
    for (const v of raw) {
      const n = Number(v)
      if (!Number.isInteger(n) || n < 1) {
        throw new ApiError('orderedIds contains an invalid product id', 400)
      }
      if (!ids.includes(n)) ids.push(n)
    }

    // Only ids that actually exist are written (others are ignored).
    const existing = await db.product.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    })
    const existingIds = new Set(existing.map((row) => row.id))
    const updates = ids
      .map((id, index) => ({ id, displayOrder: index }))
      .filter((u) => existingIds.has(u.id))

    const updated = await db.$transaction(async (tx) => {
      let count = 0
      for (const u of updates) {
        await tx.product.update({
          where: { id: u.id },
          data: { displayOrder: u.displayOrder },
        })
        count += 1
      }
      return count
    })

    await logAuditEntry({
      user,
      action: 'products.reorder',
      entity: 'product',
      entityId: null,
      details: `Menu order saved (${updated} product${updated === 1 ? '' : 's'})`,
    })

    return NextResponse.json({ updated })
  } catch (err) {
    return errorResponse(err)
  }
}
