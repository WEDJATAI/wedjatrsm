// Shared helpers for the /api/customers routes (R12, agent 12-a).
// Serialization + payload validation for the Customer CRM, plus the
// fire-and-forget audit rows for the 'customer.*' actions.
//
// Audit deviation (documented, same approach R8-a took for
// 'modifierGroup.*' and R8-d for 'drawer.*'): 'customer.create' /
// 'customer.update' / 'customer.loyaltyAdjust' are not in lib/audit's
// AUDIT_ACTIONS union and lib/audit.ts is outside 12-a ownership → rows
// are written directly via db.auditLog.create with entity 'customer'.

import { db } from '@/lib/db'
import { ApiError, type SessionPayload } from '@/lib/auth'
import { round2 } from '@/lib/orders'
import type { Customer, LoyaltyTransaction } from '@/lib/types'

/** A raw Customer DB row (no relations). */
export type CustomerRow = {
  id: number
  name: string
  phone: string | null
  email: string | null
  notes: string | null
  birthday: string | null
  loyaltyPoints: number
  visits: number
  totalSpend: number
  active: boolean
  createdAt: Date
}

export function serializeCustomer(row: CustomerRow, lastVisitAt?: Date | null): Customer {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    notes: row.notes,
    birthday: row.birthday,
    loyaltyPoints: row.loyaltyPoints,
    visits: row.visits,
    totalSpend: round2(row.totalSpend),
    active: row.active,
    createdAt: row.createdAt.toISOString(),
    lastVisitAt: lastVisitAt != null ? new Date(lastVisitAt).toISOString() : null,
  }
}

/** A raw LoyaltyTransaction row (with its optional order summary). */
export type LoyaltyRow = {
  id: number
  customerId: number
  points: number
  kind: string
  orderId: number | null
  note: string | null
  createdAt: Date
  order?: { id: number; totalAmount: number } | null
}

export function serializeLoyalty(row: LoyaltyRow): LoyaltyTransaction {
  return {
    id: row.id,
    customerId: row.customerId,
    points: row.points,
    kind: row.kind,
    orderId: row.orderId,
    order: row.order ? { id: row.order.id, totalAmount: round2(row.order.totalAmount) } : null,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
  }
}

/** Fire-and-forget audit row for the customer.* actions (never throws). */
export async function logCustomerAudit(
  user: Pick<SessionPayload, 'userId' | 'name'> | null | undefined,
  action: 'customer.create' | 'customer.update' | 'customer.loyaltyAdjust',
  entityId: number,
  details: string,
): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        userId: user?.userId ?? null,
        userName: user?.name ?? 'system',
        action,
        entity: 'customer',
        entityId,
        details,
      },
    })
  } catch (err) {
    console.error('[audit-log] failed to record', action, err)
  }
}

// ─── Payload validation (POST create + PUT partial) ─────────────────

const BIRTHDAY_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/ // 'MM-DD'

/** Validated writable fields — only the keys present in the request body. */
export type CustomerPatch = {
  name?: string
  phone?: string | null
  email?: string | null
  notes?: string | null
  birthday?: string | null
  active?: boolean
}

/**
 * Validate a customer payload. POST uses { requireName: true } (name 1-80
 * mandatory); PUT passes only the fields it wants to change.
 * phone: optional, 4-25 chars after trim ('' clears it); email ≤ 120;
 * notes ≤ 500; birthday 'MM-DD'; active boolean.
 */
export function validateCustomerPatch(
  body: Record<string, unknown>,
  opts: { requireName: boolean },
): CustomerPatch {
  const patch: CustomerPatch = {}

  if (body.name !== undefined || opts.requireName) {
    const name = body.name == null ? '' : String(body.name).trim()
    if (name.length < 1 || name.length > 80) {
      throw new ApiError('Name must be between 1 and 80 characters', 400)
    }
    patch.name = name
  }

  if (body.phone !== undefined) {
    const phone = body.phone == null ? '' : String(body.phone).trim()
    if (phone === '') {
      patch.phone = null // explicit clear
    } else {
      if (phone.length < 4 || phone.length > 25) {
        throw new ApiError('Phone must be between 4 and 25 characters', 400)
      }
      patch.phone = phone
    }
  }

  if (body.email !== undefined) {
    const email = body.email == null ? '' : String(body.email).trim()
    if (email === '') {
      patch.email = null
    } else {
      if (email.length > 120) {
        throw new ApiError('Email must be at most 120 characters', 400)
      }
      patch.email = email
    }
  }

  if (body.notes !== undefined) {
    const notes = body.notes == null ? '' : String(body.notes).trim()
    if (notes.length > 500) {
      throw new ApiError('Notes must be at most 500 characters', 400)
    }
    patch.notes = notes === '' ? null : notes
  }

  if (body.birthday !== undefined) {
    const birthday = body.birthday == null ? '' : String(body.birthday).trim()
    if (birthday === '') {
      patch.birthday = null
    } else {
      if (!BIRTHDAY_RE.test(birthday)) {
        throw new ApiError('Birthday must be in MM-DD format', 400)
      }
      patch.birthday = birthday
    }
  }

  if (body.active !== undefined) {
    if (typeof body.active !== 'boolean') {
      throw new ApiError('active must be a boolean', 400)
    }
    patch.active = body.active
  }

  return patch
}

/** Throw 409 when another customer already owns this phone number. */
export async function assertPhoneAvailable(
  phone: string | null | undefined,
  excludeId?: number,
): Promise<void> {
  if (phone == null) return
  const existing = await db.customer.findUnique({ where: { phone }, select: { id: true } })
  if (existing && existing.id !== excludeId) {
    throw new ApiError('Phone already exists', 409)
  }
}

// ─── Phone lookup helpers (GET ?phone=) ─────────────────────────────

/** Keep digits only — strips spaces, dashes, parentheses and '+'. */
export function normalizePhoneDigits(raw: string): string {
  return raw.replace(/\D+/g, '')
}

/**
 * Digit-normalized phone match tolerant of the international prefix vs
 * local leading-zero spellings: '+20 100 123 4567' ↔ '0100 123 4567' both
 * resolve to the same subscriber (equal digits, or one endsWith the other
 * once both are long enough to be a real number).
 */
export function phoneMatches(storedPhone: string | null | undefined, queryDigits: string): boolean {
  if (!queryDigits) return false
  const stored = normalizePhoneDigits(storedPhone ?? '')
  if (!stored) return false
  if (stored === queryDigits) return true
  const shorter = Math.min(stored.length, queryDigits.length)
  if (shorter < 7) return false // too short to compare meaningfully
  return stored.endsWith(queryDigits) || queryDigits.endsWith(stored)
}
