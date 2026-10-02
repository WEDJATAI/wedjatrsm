// /api/suppliers/[id] — R17 Purchasing: update / delete a supplier.
// PUT    → same fields as POST (absent name keeps the current one) + audit
//          'supplier.update'; 404 when the supplier does not exist.
// DELETE → 409 while any purchase order references the supplier (history is
//          immutable), otherwise delete + audit 'supplier.delete'.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, errorResponse, ApiError } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
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

const SUPPLIER_AGG_INCLUDE = {
  purchaseOrders: {
    select: { status: true, lines: { select: { receivedQuantity: true, unitCost: true } } },
  },
} as const

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

function parseIdParam(id: string): number {
  const n = Number(id)
  if (!Number.isInteger(n) || n <= 0) throw new ApiError('Invalid supplier id', 400)
  return n
}

/** Optional text field → trimmed string | null (empty/null clears). */
function optionalText(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string') throw new ApiError(`${label} must be a string`, 400)
  const s = value.trim()
  return s === '' ? null : s
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAuth(req, ['admin', 'purchases'])
    const id = parseIdParam((await params).id)

    let body: unknown
    try {
      body = await req.json()
    } catch {
      throw new ApiError('Invalid JSON body', 400)
    }
    const data = (body ?? {}) as Record<string, unknown>

    const existing = await db.supplier.findUnique({ where: { id } })
    if (!existing) throw new ApiError('Supplier not found', 404)

    // name: absent → keep current; present but empty → 400
    let name = existing.name
    if (data.name !== undefined) {
      name = typeof data.name === 'string' ? data.name.trim() : ''
      if (!name) throw new ApiError('Name is required', 400)
    }

    const updates: {
      name: string
      phone?: string | null
      email?: string | null
      address?: string | null
      notes?: string | null
      active?: boolean
    } = { name }

    if (data.phone !== undefined) updates.phone = optionalText(data.phone, 'Phone')
    if (data.email !== undefined) updates.email = optionalText(data.email, 'Email')
    if (data.address !== undefined) updates.address = optionalText(data.address, 'Address')
    if (data.notes !== undefined) updates.notes = optionalText(data.notes, 'Notes')
    if (data.active !== undefined) {
      if (typeof data.active !== 'boolean') {
        throw new ApiError('active must be true or false', 400)
      }
      updates.active = data.active
    }

    const updated = (await db.supplier.update({
      where: { id },
      data: updates,
      include: SUPPLIER_AGG_INCLUDE,
    })) as SupplierWithOrders

    await logAudit({
      user,
      action: 'supplier.update',
      entity: 'supplier',
      entityId: id,
      details: `${updated.name}${updated.phone ? ` · ${updated.phone}` : ''}${
        updates.active !== undefined ? ` — ${updated.active ? 'active' : 'inactive'}` : ''
      }`,
    })

    return NextResponse.json({ supplier: serializeSupplier(updated) })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAuth(req, ['admin', 'purchases'])
    const id = parseIdParam((await params).id)

    const existing = await db.supplier.findUnique({
      where: { id },
      include: { _count: { select: { purchaseOrders: true } } },
    })
    if (!existing) throw new ApiError('Supplier not found', 404)

    // Purchase history is immutable — suppliers with POs cannot be removed.
    if (existing._count.purchaseOrders > 0) {
      throw new ApiError(
        `Supplier has ${existing._count.purchaseOrders} purchase order(s) and cannot be deleted`,
        409,
      )
    }

    await db.supplier.delete({ where: { id } })

    await logAudit({
      user,
      action: 'supplier.delete',
      entity: 'supplier',
      entityId: id,
      details: existing.name,
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return errorResponse(err)
  }
}
