import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth, type SessionPayload } from '@/lib/auth'

// ── R11: drag-sort persistence (products) ────────────────────────────
// r48: Product has NO per-row displayOrder field (order is driven by the
// CATEGORY's displayOrder, then product name — see GET /api/products).
// This endpoint has no frontend caller; it is kept as an honest no-op so
// any stale integrations get a 200 instead of a Prisma unknown-arg crash.

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

    // Product rows carry no order column — menu order is category-driven.
    // Count the existing ids so the audit trail reflects reality, then no-op.
    const existing = await db.product.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    })

    await logAuditEntry({
      user,
      action: 'products.reorder',
      entity: 'product',
      entityId: null,
      details: `No-op (${existing.length} known product id(s)) — product order follows category order`,
    })

    return NextResponse.json({ updated: 0, known: existing.length })
  } catch (err) {
    return errorResponse(err)
  }
}
