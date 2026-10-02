// /api/waste — waste log (Foodics Waste). POST logs a loss: it deducts
// stock, writes an InventoryTransaction with reason 'waste' (mirroring the
// /api/inventory/adjust ledger behavior, incl. the below-zero guard) and
// records the cost value at the moment of loss. GET lists entries newest
// first within a local-time date window (default: last 30 days), wrapped
// as {wasteLogs} to match the project's list-response convention.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, errorResponse, ApiError } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { WASTE_REASONS } from '@/lib/constants'
import type { WasteLogDTO } from '@/lib/types'

const round2 = (n: number): number => Math.round(n * 100) / 100

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

/** Parse 'YYYY-MM-DD' into a LOCAL-time Date (avoids the UTC shift of new Date(str)); null on garbage. */
function parseLocalDate(s: string): Date | null {
  const m = DATE_RE.exec(s)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const dt = new Date(y, mo - 1, d)
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null
  return dt
}

const WASTE_INCLUDE = {
  product: { select: { id: true, name: true, nameAr: true } },
  user: { select: { id: true, name: true } },
} as const

type WasteRow = {
  id: number
  productId: number
  product: { id: number; name: string; nameAr: string | null } | null
  quantity: number
  costValue: number
  reason: string
  note: string | null
  user: { id: number; name: string } | null
  createdAt: Date
}

/** Serialize a waste log row into the WasteLogDTO API payload. */
function toWasteLogDTO(w: WasteRow): WasteLogDTO {
  return {
    id: w.id,
    productId: w.productId,
    product: w.product
      ? { id: w.product.id, name: w.product.name, nameAr: w.product.nameAr }
      : { id: w.productId, name: `#${w.productId}`, nameAr: null },
    quantity: w.quantity,
    costValue: w.costValue,
    reason: w.reason,
    note: w.note,
    user: w.user ? { id: w.user.id, name: w.user.name } : null,
    createdAt: w.createdAt.toISOString(),
  }
}

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['admin', 'inventory'])

    const sp = new URL(req.url).searchParams
    const fromRaw = sp.get('from')
    const toRaw = sp.get('to')

    let start: Date
    let end: Date
    if (fromRaw !== null && fromRaw !== '') {
      const parsed = parseLocalDate(fromRaw)
      if (!parsed) throw new ApiError('Invalid from date: expected YYYY-MM-DD', 400)
      start = parsed
    } else {
      const now = new Date()
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30)
    }
    if (toRaw !== null && toRaw !== '') {
      const parsed = parseLocalDate(toRaw)
      if (!parsed) throw new ApiError('Invalid to date: expected YYYY-MM-DD', 400)
      end = new Date(parsed.getTime() + 24 * 60 * 60 * 1000) // inclusive day
    } else {
      const now = new Date()
      end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    }

    const entries = await db.wasteLog.findMany({
      where: { createdAt: { gte: start, lt: end } },
      orderBy: { createdAt: 'desc' },
      include: WASTE_INCLUDE,
    })

    return NextResponse.json({ wasteLogs: entries.map(toWasteLogDTO) })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireAuth(req, ['admin', 'inventory'])

    let body: unknown
    try {
      body = await req.json()
    } catch {
      throw new ApiError('Invalid JSON body', 400)
    }
    const data = (body ?? {}) as Record<string, unknown>

    const productId = Number(data.productId)
    if (!Number.isInteger(productId)) {
      throw new ApiError('productId must be an integer', 400)
    }

    const quantity = Number(data.quantity)
    if (!Number.isFinite(quantity) || quantity <= 0) {
      throw new ApiError('quantity must be a number greater than 0', 400)
    }

    const reason = typeof data.reason === 'string' ? data.reason.trim() : ''
    if (!WASTE_REASONS.includes(reason as (typeof WASTE_REASONS)[number])) {
      throw new ApiError(
        `reason must be one of ${WASTE_REASONS.join(', ')}`,
        400,
      )
    }

    const note =
      typeof data.note === 'string' && data.note.trim() !== '' ? data.note.trim() : null

    const product = await db.product.findUnique({ where: { id: productId } })
    if (!product) throw new ApiError('Product not found', 400)
    if (!product.active || !product.isStockable) {
      throw new ApiError('Product is not an active stockable item', 400)
    }

    // Same below-zero guard as /api/inventory/adjust (no clamping — refuse).
    const newStock = product.stock - quantity
    if (newStock < 0) {
      throw new ApiError(
        `Insufficient stock: cannot reduce below zero (current ${product.stock})`,
        400,
      )
    }

    const costValue = round2(quantity * product.cost)

    const entry = await db.$transaction(async (tx) => {
      const saved = await tx.wasteLog.create({
        data: {
          productId,
          quantity,
          costValue,
          reason,
          note,
          userId: user.userId,
        },
        include: WASTE_INCLUDE,
      })
      await tx.product.update({
        where: { id: productId },
        data: { stock: newStock },
      })
      await tx.inventoryTransaction.create({
        data: {
          productId,
          quantityChange: -quantity,
          reason: 'waste',
        },
      })
      return saved
    })

    await logAudit({
      user,
      action: 'waste.log',
      entity: 'waste',
      entityId: entry.id,
      details: `${product.name} −${quantity} (${reason}) — value EGP ${costValue.toFixed(
        2,
      )}, stock ${product.stock} → ${newStock}${note ? ` — ${note}` : ''}`,
    })

    return NextResponse.json({ wasteLog: toWasteLogDTO(entry) }, { status: 201 })
  } catch (err) {
    return errorResponse(err)
  }
}
