// /api/suppliers — R17 Purchasing: supplier directory (Odoo-style vendors)
// GET  → { suppliers: Supplier[] } with purchaseCount + totalPurchased
//        aggregates (include+reduce: totalPurchased sums receivedQuantity ×
//        unitCost across lines of NON-cancelled POs)
// POST → create (name required) + audit 'supplier.create'

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, errorResponse, ApiError } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { emitOutboxEvent } from '@/lib/hybrid-sync/outbox'
import { round2 } from '@/lib/orders'
import type { Supplier } from '@/lib/types'

type SupplierWithOrders = {
  id: number
  name: string
  phone: string | null
  email: string | null
  address: string | null
  notes: string | null
  active: boolean
  createdAt: Date
  purchaseOrders: {
    status: string
    lines: { receivedQuantity: number; unitCost: number }[]
  }[]
}

/** Include shape shared by GET (and the [id] route's re-serialization). */
const SUPPLIER_AGG_INCLUDE = {
  purchaseOrders: {
    select: { status: true, lines: { select: { receivedQuantity: true, unitCost: true } } },
  },
} as const

/** Supplier row (+PO aggregates) → API DTO. */
function serializeSupplier(row: SupplierWithOrders): Supplier {
  let totalPurchasedRaw = 0
  for (const po of row.purchaseOrders) {
    if (po.status === 'cancelled') continue
    for (const line of po.lines) {
      totalPurchasedRaw += line.receivedQuantity * line.unitCost
    }
  }
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    address: row.address,
    notes: row.notes,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    purchaseCount: row.purchaseOrders.length,
    totalPurchased: round2(totalPurchasedRaw),
  }
}

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['admin', 'purchases'])

    const suppliers = (await db.supplier.findMany({
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
      include: SUPPLIER_AGG_INCLUDE,
    })) as SupplierWithOrders[]

    return NextResponse.json({ suppliers: suppliers.map(serializeSupplier) })
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

    const name = typeof data.name === 'string' ? data.name.trim() : ''
    if (!name) throw new ApiError('Name is required', 400)

    const phone = optionalText(data.phone, 'Phone')
    const email = optionalText(data.email, 'Email')
    const address = optionalText(data.address, 'Address')
    const notes = optionalText(data.notes, 'Notes')
    const active = data.active === undefined ? true : parseActive(data.active)

    // R38 hybrid sync: the supplier write + its outbox event commit together
    // (revision-aware Supplier). The tx writes the plain row so the event
    // payload carries raw columns only; the response row (with PO aggregates)
    // is re-read afterwards.
    const saved = await db.$transaction(async (tx) => {
      const row = await tx.supplier.create({ data: { name, phone, email, address, notes, active } })
      await emitOutboxEvent(tx, {
        entity: 'Supplier',
        entityId: row.id,
        operation: 'create',
        row,
      })
      return row
    })

    const created = (await db.supplier.findUniqueOrThrow({
      where: { id: saved.id },
      include: SUPPLIER_AGG_INCLUDE,
    })) as SupplierWithOrders

    await logAudit({
      user,
      action: 'supplier.create',
      entity: 'supplier',
      entityId: created.id,
      details: `${created.name}${phone ? ` · ${phone}` : ''}`,
    })

    return NextResponse.json({ supplier: serializeSupplier(created) })
  } catch (err) {
    return errorResponse(err)
  }
}

/** Optional text field → trimmed string | null (empty/null clears). */
function optionalText(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new ApiError(`${label} must be a string`, 400)
  const s = value.trim()
  return s === '' ? null : s
}

function parseActive(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new ApiError('active must be true or false', 400)
  return value
}
