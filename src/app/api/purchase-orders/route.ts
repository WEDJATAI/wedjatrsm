// /api/purchase-orders — R17 Purchasing: PO list + creation (Odoo Purchasing).
// GET  → { purchaseOrders: PurchaseOrderDTO[] } newest first, optional
//        ?status=draft|ordered|received|cancelled filter. Lines include the
//        product snapshot; all money aggregates are round2-ed.
// POST → create as 'draft' with an auto-generated "PO-0001" number (max
//        numeric suffix + 1) inside a $transaction with nested line creates.
//        createdById = session user. Audit 'purchase.create'.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, errorResponse, ApiError } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { round2 } from '@/lib/orders'
import type { PurchaseOrderDTO } from '@/lib/types'

const PO_STATUSES = ['draft', 'ordered', 'received', 'cancelled'] as const
type POStatus = (typeof PO_STATUSES)[number]

type POLineRow = {
  id: number
  productId: number
  product: { id: number; name: string; nameAr: string | null; sku: string | null; cost: number }
  quantity: number
  receivedQuantity: number
  unitCost: number
}

type PORow = {
  id: number
  number: string
  supplierId: number
  supplier: { id: number; name: string }
  status: string
  note: string | null
  expectedAt: Date | null
  orderedAt: Date | null
  receivedAt: Date | null
  createdAt: Date
  createdBy: { name: string } | null
  lines: POLineRow[]
}

/** PO row (+relations) → API DTO with round2 money aggregates. */
function serializePO(po: PORow): PurchaseOrderDTO {
  let totalRaw = 0
  let receivedRaw = 0
  let outstandingRaw = 0
  const lines = po.lines.map((line) => {
    const lineTotal = round2(line.quantity * line.unitCost)
    totalRaw += line.quantity * line.unitCost
    receivedRaw += line.receivedQuantity * line.unitCost
    const remaining = Math.max(0, line.quantity - line.receivedQuantity)
    outstandingRaw += remaining * line.unitCost
    return {
      id: line.id,
      productId: line.productId,
      product: line.product,
      quantity: line.quantity,
      receivedQuantity: line.receivedQuantity,
      unitCost: line.unitCost,
      lineTotal,
    }
  })
  return {
    id: po.id,
    number: po.number,
    supplierId: po.supplierId,
    supplier: po.supplier,
    status: po.status,
    note: po.note,
    expectedAt: po.expectedAt ? po.expectedAt.toISOString() : null,
    orderedAt: po.orderedAt ? po.orderedAt.toISOString() : null,
    receivedAt: po.receivedAt ? po.receivedAt.toISOString() : null,
    createdAt: po.createdAt.toISOString(),
    createdBy: po.createdBy?.name ?? null,
    lines,
    total: round2(totalRaw),
    receivedTotal: round2(receivedRaw),
    outstanding: round2(outstandingRaw),
  }
}

const PO_INCLUDE = {
  supplier: { select: { id: true, name: true } },
  createdBy: { select: { name: true } },
  lines: {
    include: { product: { select: { id: true, name: true, nameAr: true, sku: true, cost: true } } },
    orderBy: { id: 'asc' as const },
  },
} as const

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['admin', 'purchases'])

    const sp = new URL(req.url).searchParams
    const statusRaw = sp.get('status')
    let status: POStatus | undefined
    if (statusRaw !== null && statusRaw !== '') {
      if (!(PO_STATUSES as readonly string[]).includes(statusRaw)) {
        throw new ApiError(
          `status must be one of ${PO_STATUSES.join(', ')}`,
          400,
        )
      }
      status = statusRaw as POStatus
    }

    const purchaseOrders = (await db.purchaseOrder.findMany({
      where: status ? { status } : undefined,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: PO_INCLUDE,
    })) as PORow[]

    return NextResponse.json({ purchaseOrders: purchaseOrders.map(serializePO) })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireAuth(req, ['admin', 'purchases'])

    let body: unknown
    try {
      body = await req.json()
    } catch {
      throw new ApiError('Invalid JSON body', 400)
    }
    const data = (body ?? {}) as Record<string, unknown>

    // ── supplier ──
    const supplierId = Number(data.supplierId)
    if (!Number.isInteger(supplierId) || supplierId <= 0) {
      throw new ApiError('supplierId must be a valid id', 400)
    }
    const supplier = await db.supplier.findUnique({ where: { id: supplierId } })
    if (!supplier) throw new ApiError('Supplier not found', 400)
    if (!supplier.active) throw new ApiError('Supplier is inactive', 400)

    // ── note / expectedAt ──
    let note: string | null = null
    if (data.note !== undefined && data.note !== null) {
      if (typeof data.note !== 'string') throw new ApiError('note must be a string', 400)
      note = data.note.trim() || null
    }

    let expectedAt: Date | null = null
    if (data.expectedAt !== undefined && data.expectedAt !== null && data.expectedAt !== '') {
      if (typeof data.expectedAt !== 'string') {
        throw new ApiError('expectedAt must be an ISO date string', 400)
      }
      const parsed = new Date(data.expectedAt)
      if (Number.isNaN(parsed.getTime())) {
        throw new ApiError('expectedAt is not a valid date', 400)
      }
      expectedAt = parsed
    }

    // ── lines ──
    if (!Array.isArray(data.lines) || data.lines.length === 0) {
      throw new ApiError('At least one line is required', 400)
    }
    const parsedLines: { productId: number; quantity: number; unitCost: number }[] = []
    for (const [index, raw] of data.lines.entries()) {
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new ApiError(`lines[${index}] must be an object`, 400)
      }
      const line = raw as Record<string, unknown>
      const productId = Number(line.productId)
      if (!Number.isInteger(productId) || productId <= 0) {
        throw new ApiError(`lines[${index}].productId must be a valid id`, 400)
      }
      const quantity = Number(line.quantity)
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new ApiError(`lines[${index}].quantity must be greater than 0`, 400)
      }
      const unitCost = Number(line.unitCost)
      if (!Number.isFinite(unitCost) || unitCost < 0) {
        throw new ApiError(`lines[${index}].unitCost must be a number ≥ 0`, 400)
      }
      parsedLines.push({ productId, quantity, unitCost })
    }

    const productIds = [...new Set(parsedLines.map((l) => l.productId))]
    const products = await db.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true },
    })
    if (products.length !== productIds.length) {
      throw new ApiError('One or more products do not exist', 400)
    }

    // ── create (number generated inside the transaction) ──
    const created = await db.$transaction(async (tx) => {
      const existingNumbers = await tx.purchaseOrder.findMany({ select: { number: true } })
      let maxSuffix = 0
      for (const row of existingNumbers) {
        const m = /^PO-(\d+)$/.exec(row.number)
        if (m) maxSuffix = Math.max(maxSuffix, Number(m[1]))
      }
      const number = `PO-${String(maxSuffix + 1).padStart(4, '0')}`

      return tx.purchaseOrder.create({
        data: {
          number,
          supplierId,
          status: 'draft',
          note,
          expectedAt,
          createdById: user.userId,
          lines: {
            create: parsedLines.map((l) => ({
              productId: l.productId,
              quantity: l.quantity,
              unitCost: l.unitCost,
            })),
          },
        },
        include: PO_INCLUDE,
      })
    })

    const dto = serializePO(created as PORow)

    await logAudit({
      user,
      action: 'purchase.create',
      entity: 'purchase',
      entityId: created.id,
      details: `${created.number} — ${supplier.name} · ${parsedLines.length} line(s) · total ${dto.total}`,
    })

    return NextResponse.json({ purchaseOrder: dto })
  } catch (err) {
    return errorResponse(err)
  }
}
