// /api/orders/[id] — fetch (any authenticated) + modify open orders (waiter/admin)

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth, verifyDeveloperPin, verifyPassword } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { COURSES } from '@/lib/constants'
import { checkRateLimit, peekRateLimit } from '@/lib/rate-limit'
import { emitOutboxEvent } from '@/lib/hybrid-sync/outbox'
import {
  checkStockAvailability,
  getOrderOr404,
  parseId,
  recomputeTotals,
  serializeOrder,
  validateOrderItems,
} from '@/lib/orders'

/**
 * R16 hardening: the shared 6-digit manager PIN used for item removal and
 * discounts is enumerable without a per-user attempt budget. 5 failed
 * verifications per staff member per 5 minutes; correct PINs never count.
 */
function guardManagerPinBudget(userId: number) {
  const key = `mgrpin:${userId}`
  const peek = peekRateLimit(key, 5, 5 * 60 * 1000)
  if (!peek.ok) {
    throw new ApiError(
      `Too many wrong PIN attempts — try again in ${peek.retryAfterSec}s`,
      429,
    )
  }
  return key
}

function recordManagerPinFailure(key: string) {
  checkRateLimit(key, 5, 5 * 60 * 1000)
}

/**
 * r68: the item-edit credential is the ACTING USER'S OWN — their 6-digit
 * quick-login PIN or their account password (owner directive: "the password
 * for editing the ordered item is the same as the user's password"). The
 * developer PIN remains accepted as the owner's master override so a user
 * who forgot both credentials can still be unblocked in person. Replaces
 * the r65 developer-PIN-only gate. Returns HOW it verified (for the audit
 * trail) or null on mismatch.
 */
async function verifyItemEditCredential(
  userId: number,
  input: string,
): Promise<'pin' | 'password' | 'developer-pin' | null> {
  const trimmed = input.trim()
  if (!trimmed || trimmed.length > 64) return null
  const row = await db.user.findUnique({
    where: { id: userId },
    select: { pin: true, passwordHash: true },
  })
  if (row) {
    if (row.pin != null && /^\d{6}$/.test(trimmed) && row.pin === trimmed) return 'pin'
    if (await verifyPassword(trimmed, row.passwordHash)) return 'password'
  }
  if (await verifyDeveloperPin(trimmed)) return 'developer-pin'
  return null
}

type Ctx = { params: Promise<{ id: string }> }

/** Fire-and-forget audit row for manager-approved discounts (R8).
 *  ('order.discount' is not in lib/audit's AUDIT_ACTIONS union and that
 *  file is outside R8-b ownership — same direct-row approach as R8-a.) */
async function logDiscountAudit(
  user: { userId?: number; name?: string },
  orderId: number,
  details: string,
): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        userId: user.userId ?? null,
        userName: user.name ?? 'system',
        action: 'order.discount',
        entity: 'order',
        entityId: orderId,
        details,
      },
    })
  } catch (err) {
    console.error('[audit-log] failed to record order.discount', err)
  }
}

export async function GET(req: NextRequest, ctx: Ctx) {
  try {
    await requireAuth(req)
    const { id } = await ctx.params
    const orderId = parseId(id, 'order id')
    const order = await getOrderOr404(orderId)
    return NextResponse.json({ order: serializeOrder(order) })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  try {
    const user = await requireAuth(req, ['waiter', 'admin', 'pos'])
    const { id } = await ctx.params
    const orderId = parseId(id, 'order id')

    const existing = await db.order.findUnique({
      where: { id: orderId },
      select: { id: true, status: true, discountAmount: true },
    })
    if (!existing) throw new ApiError('Order not found', 404)
    if (existing.status !== 'open') {
      throw new ApiError('Only open orders can be modified', 400)
    }

    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })
    const { addItems, removeItemIds, updateItems, discountAmount, guests } = body ?? {}

    // Add new items (same validation as order creation, stock-aware)
    if (addItems != null) {
      const items = await validateOrderItems(addItems)
      await checkStockAvailability(items, orderId)
      await db.$transaction(async (tx) => {
        // R30 hybrid sync: read-back window — createMany returns no rows, so
        // the new items are identified by id > the order's previous max.
        const lastItem = await tx.orderItem.findFirst({
          where: { orderId },
          orderBy: { id: 'desc' },
          select: { id: true },
        })
        const maxItemId = lastItem?.id ?? 0
        await tx.orderItem.createMany({
          data: items.map((item) => ({
            orderId,
            productId: item.productId,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            notes: item.notes,
            course: item.course,
            status: 'new',
            // R8: option snapshot (validated server-side by validateOrderItems)
            selectedModifiers: item.selectedModifiers
              ? JSON.stringify(item.selectedModifiers)
              : undefined,
          })),
        })
        const createdItems = await tx.orderItem.findMany({
          where: { orderId, id: { gt: maxItemId } },
        })
        for (const item of createdItems) {
          await emitOutboxEvent(tx, {
            entity: 'OrderItem',
            entityId: item.id,
            operation: 'create',
            row: item,
          })
        }
        const orderRow = await tx.order.findUnique({ where: { id: orderId } })
        if (orderRow) {
          await emitOutboxEvent(tx, {
            entity: 'Order',
            entityId: orderId,
            operation: 'update',
            row: orderRow,
          })
        }
      })
    }

    // Remove items (must belong to this order) — credential-gated (r68):
    // the ACTING USER'S OWN PIN or password authorizes item removal for any
    // role (owner directive "the password for editing the ordered item is
    // the same as the user's password"); the developer PIN stays accepted
    // as the owner's master override. This replaces the r65 developer-PIN
    // gate and, before it, the never-configured AppSetting 'deleteItemPin'.
    if (removeItemIds != null) {
      if (!Array.isArray(removeItemIds)) {
        throw new ApiError('removeItemIds must be an array of item ids', 400)
      }
      const ids = removeItemIds.map(Number)
      if (ids.some((itemId) => !Number.isInteger(itemId) || itemId <= 0)) {
        throw new ApiError('removeItemIds contains an invalid item id', 400)
      }
      if (ids.length > 0) {
        const credential = typeof body?.removePin === 'string' ? body.removePin : ''
        if (credential.trim().length < 4) {
          throw new ApiError('Your PIN or password is required to remove items', 403)
        }
        const pinBudgetKey = guardManagerPinBudget(user.userId)
        const verifiedAs = await verifyItemEditCredential(user.userId, credential)
        if (!verifiedAs) {
          recordManagerPinFailure(pinBudgetKey)
          throw new ApiError('Wrong PIN or password — item removal denied', 403)
        }
        // snapshot the doomed lines first so the audit row can name them
        // (read-only — the delete below is the existing behavior)
        const doomed = await db.orderItem.findMany({
          where: { id: { in: ids }, orderId },
          select: {
            id: true,
            quantity: true,
            product: { select: { name: true } },
          },
        })
        const removed = await db.$transaction(async (tx) => {
          // R30 hybrid sync: full pre-delete rows so the outbox events carry
          // the deleted snapshot atomically with the deleteMany.
          const doomedRows = await tx.orderItem.findMany({
            where: { id: { in: ids }, orderId },
          })
          const result = await tx.orderItem.deleteMany({ where: { id: { in: ids }, orderId } })
          for (const row of doomedRows) {
            await emitOutboxEvent(tx, {
              entity: 'OrderItem',
              entityId: row.id,
              operation: 'delete',
              row,
            })
          }
          if (result.count > 0) {
            const orderRow = await tx.order.findUnique({ where: { id: orderId } })
            if (orderRow) {
              await emitOutboxEvent(tx, {
                entity: 'Order',
                entityId: orderId,
                operation: 'update',
                row: orderRow,
              })
            }
          }
          return result
        })
        if (removed.count > 0) {
          await logAudit({
            user,
            action: 'order.itemDelete',
            entity: 'order',
            entityId: orderId,
            details: `${doomed
              .map((item) => `${item.quantity}× ${item.product?.name ?? `item ${item.id}`}`)
              .join(', ')} removed from order #${orderId} (verified: ${verifiedAs})`,
          })
        }
      }
    }

    // Update item quantity / notes / course (must belong to this order)
    if (updateItems != null) {
      if (!Array.isArray(updateItems)) {
        throw new ApiError('updateItems must be an array', 400)
      }
      await db.$transaction(async (tx) => {
        for (const raw of updateItems) {
          const itemId = Number(raw?.id)
          if (!Number.isInteger(itemId) || itemId <= 0) {
            throw new ApiError('updateItems contains an invalid item id', 400)
          }
          const data: { quantity?: number; notes?: string | null; course?: string } = {}
          if (raw.quantity != null) {
            const quantity = Number(raw.quantity)
            if (!Number.isFinite(quantity) || quantity <= 0) {
              throw new ApiError('Item quantity must be greater than zero', 400)
            }
            data.quantity = quantity
          }
          if (raw.notes !== undefined) {
            data.notes = raw.notes == null ? null : String(raw.notes)
          }
          if (raw.course != null) {
            const course = String(raw.course)
            if (!(COURSES as readonly string[]).includes(course)) {
              throw new ApiError(`Invalid course "${course}"`, 400)
            }
            data.course = course
          }
          const result = await tx.orderItem.updateMany({ where: { id: itemId, orderId }, data })
          if (result.count === 0) {
            throw new ApiError(`Order item ${itemId} not found`, 404)
          }
          // R30 hybrid sync: the updated row rides the same transaction
          const updatedRow = await tx.orderItem.findUnique({ where: { id: itemId } })
          if (updatedRow) {
            await emitOutboxEvent(tx, {
              entity: 'OrderItem',
              entityId: itemId,
              operation: 'update',
              row: updatedRow,
            })
          }
        }
        if (updateItems.length > 0) {
          const orderRow = await tx.order.findUnique({ where: { id: orderId } })
          if (orderRow) {
            await emitOutboxEvent(tx, {
              entity: 'Order',
              entityId: orderId,
              operation: 'update',
              row: orderRow,
            })
          }
        }
      })
    }

    // Absolute discount in EGP (clamped to subtotal inside recomputeTotals).
    // R8: manager-approved discounts — whenever the resulting amount is > 0
    // a reason (≥ 2 chars) is required and non-admin users must supply the
    // 6-digit approval PIN (r65: the DEVELOPER PIN — same authority as item
    // removal, replacing the never-configured 'deleteItemPin' setting).
    // Removing a discount (0) needs neither.
    if (discountAmount != null) {
      const discount = Number(discountAmount)
      if (!Number.isFinite(discount) || discount < 0) {
        throw new ApiError('Discount amount must be a non-negative number', 400)
      }
      const reason = body?.discountReason == null ? '' : String(body.discountReason).trim()
      if (discount > 0 && reason.length < 2) {
        throw new ApiError('A discount reason of at least 2 characters is required', 400)
      }
      const pinApproved = discount > 0 && user.role !== 'admin'
      if (pinApproved) {
        const pin = typeof body?.approvalPin === 'string' ? body.approvalPin : ''
        if (!/^\d{6}$/.test(pin)) {
          throw new ApiError('Approval PIN required', 403)
        }
        const pinBudgetKey = guardManagerPinBudget(user.userId)
        if (!(await verifyDeveloperPin(pin))) {
          recordManagerPinFailure(pinBudgetKey)
          throw new ApiError('Invalid approval PIN', 403)
        }
      }
      await db.$transaction(async (tx) => {
        const updatedOrder = await tx.order.update({
          where: { id: orderId },
          data: {
            discountAmount: discount,
            discountReason: discount > 0 ? reason : null,
          },
        })
        // R30 hybrid sync: the discount write rides the same transaction
        await emitOutboxEvent(tx, {
          entity: 'Order',
          entityId: orderId,
          operation: 'update',
          row: updatedOrder,
        })
      })
      if (discount > 0) {
        await logDiscountAudit(
          user,
          orderId,
          `EGP ${discount.toFixed(2)} discount on order #${orderId} — ${reason}${
            pinApproved ? ' (manager PIN verified)' : ' (admin)'
          }`,
        )
      } else if ((existing?.discountAmount ?? 0) > 0) {
        await logDiscountAudit(user, orderId, `Discount removed from order #${orderId}`)
      }
    }

    // Number of guests seated on this order (integer 1-30)
    if (guests != null) {
      const parsedGuests = Number(guests)
      if (!Number.isInteger(parsedGuests) || parsedGuests < 1 || parsedGuests > 30) {
        throw new ApiError('Guests must be between 1 and 30', 400)
      }
      await db.$transaction(async (tx) => {
        const updatedOrder = await tx.order.update({
          where: { id: orderId },
          data: { guests: parsedGuests },
        })
        // R30 hybrid sync: the guest-count write rides the same transaction
        await emitOutboxEvent(tx, {
          entity: 'Order',
          entityId: orderId,
          operation: 'update',
          row: updatedOrder,
        })
      })
    }

    // R13: loyalty — attach / detach the customer profile on an open order
    // (null detaches). Waiters may attach; the audit row records who.
    if (body?.customerId !== undefined) {
      let customerId: number | null = null
      if (body.customerId != null) {
        const n = Number(body.customerId)
        if (!Number.isInteger(n)) throw new ApiError('customerId must be a valid id', 400)
        const customer = await db.customer.findUnique({
          where: { id: n },
          select: { id: true, active: true, name: true },
        })
        if (!customer || !customer.active) throw new ApiError('Customer not found', 400)
        customerId = customer.id
      }
      await db.$transaction(async (tx) => {
        const updatedOrder = await tx.order.update({
          where: { id: orderId },
          data: { customerId },
        })
        // R30 hybrid sync: the attach/detach write rides the same transaction
        await emitOutboxEvent(tx, {
          entity: 'Order',
          entityId: orderId,
          operation: 'update',
          row: updatedOrder,
        })
      })
      await logAudit({
        user,
        action: 'order.update',
        entity: 'order',
        entityId: orderId,
        details: customerId
          ? `Customer attached to order #${orderId} (#${customerId})`
          : `Customer detached from order #${orderId}`,
      })
    }

    const order = await recomputeTotals(orderId)
    return NextResponse.json({ order })
  } catch (err) {
    return errorResponse(err)
  }
}
