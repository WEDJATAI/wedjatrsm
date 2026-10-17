// /api/integrations/mazaj/revoke — r55 mazaj-admin revoke of a shisha
// order, PIN-gated by owner directive:
//   "any revoke for the shisha, mazaj admin must also put a PIN number
//    for the revoke request"
//
// Mazaj (the hookah platform) already pushes orders INTO RSM through the
// delivery webhook (provider 'mazaj'). This endpoint is the reverse
// control: a mazaj admin revoking a shisha order they pushed (guest
// cancelled, wrong table, duplicate…). Because a revoke moves MONEY or
// deletes lines from a live check, the request is DUAL-AUTHORIZED:
//   1. x-rsm-key — the SAME delivery webhook key (machine-to-machine)
//   2. pin — a 6-digit RSM STAFF PIN (users.pin, active accounts only —
//      the exact authority the in-POS revoke uses). The mazaj admin must
//      obtain it from the cashier/manager on duty, and the authorizing
//      staff member's name is stamped into the audit trail.
//
// Contract (POST, x-rsm-key header or ?key= query — same as the webhook):
//   {
//     "externalId": "cmv8nz0ps0002ku08nrn4akht",  // the mazaj order id
//     "pin":     "112233",                        // REQUIRED — staff PIN
//     "reason":  "Guest cancelled the shisha",    // REQUIRED (audit trail)
//     "operator": "Mazaj Admin — Karim"           // optional, audit trail
//   }
//
// Resolution (mirrors how the order webhook stamped the delivery):
//   · Order.externalRef = 'mazaj:<externalId>' → the whole order is
//     mazaj's (standalone check): revoke transitions the ORDER.
//   · else the mazaj seen-ledger (mazaj.seen.mazaj:<externalId>) → the
//     delivery ADDED items to a shared table check: revoke removes
//     exactly those OrderItems (ledger itemIds) from the open check.
//   · unknown externalId → 404.
//
// Behaviour by state (standalone path):
//   'open' | 'deferred' → organic CANCEL (status 'cancelled' + closedAt +
//        table released — the exact cancel-route semantics, no session)
//   'paid'  → payment REVOKE (one negative Payment reversing the full
//        paid-minus-refunded capacity + status 'revoked' — the exact
//        r32 revoke-route semantics)
//   'cancelled' | 'revoked' → idempotent replay: current state +
//        duplicate: true (mazaj retries are safe)
//   'merged' → 409 (the items live on in the merge target — revoke from
//        the POS on the target check)
//
// Behaviour by state (add-to-check path):
//   check 'open' → the ledger's still-present items are deleted (their
//        own outbox delete events + recompute); already-gone items are
//        skipped → fully-idempotent replay returns duplicate: true
//   check 'paid' | other → 409 (a paid check must never be rewritten
//        from an integration — the cashier revokes the whole check in
//        the POS with their own PIN)
//
// Every write rides the R30 outbox (local ↔ cloud parity), exactly like
// the in-POS flows. Rate limit: 10 attempts / 5 min per IP.
import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { errorResponse, ApiError } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import {
  DELIVERY_WEBHOOK_KEY_SETTING,
  MAZAJ_SEEN_PREFIX,
  PIN_LENGTH,
} from '@/lib/constants'
import {
  ORDER_INCLUDE,
  freeTableIfUnused,
  orderTableIds,
  recomputeTotals,
  round2,
  serializeOrder,
} from '@/lib/orders'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'
import { emitOutboxEvent } from '@/lib/hybrid-sync/outbox'
import { withWriteLock } from '@/lib/write-mutex'

const REASON_MAX = 140

function keysMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function POST(req: NextRequest) {
  try {
    // ── key auth (header takes precedence; query param allowed — same
    // contract as the delivery webhook) ──
    const provided =
      req.headers.get('x-rsm-key') ?? new URL(req.url).searchParams.get('key') ?? ''
    const stored = (await db.appSetting.findUnique({
      where: { key: DELIVERY_WEBHOOK_KEY_SETTING },
    }))?.value
    if (!stored) {
      throw new ApiError('Webhook is not configured — generate a key in Integrations', 503)
    }
    if (!provided || !keysMatch(provided.trim(), stored)) {
      throw new ApiError('Invalid webhook key', 401)
    }

    // brute-force guard: 10 attempts / 5 min per IP (PIN guessing)
    const rlKey = `mazaj-revoke:${clientIp(req)}`
    const rl = checkRateLimit(rlKey, 10, 5 * 60_000)
    if (!rl.ok) {
      throw new ApiError(`Too many attempts — try again in ${rl.retryAfterSec}s`, 429)
    }

    const body = (await req.json().catch(() => null)) as {
      externalId?: unknown
      pin?: unknown
      reason?: unknown
      operator?: unknown
    } | null

    const externalId = String(body?.externalId ?? '').trim()
    if (!externalId || externalId.length > 80) {
      throw new ApiError('externalId is required (1-80 characters)', 400)
    }
    // r55 owner directive: the PIN is MANDATORY on every mazaj revoke
    const pin = String(body?.pin ?? '').trim()
    if (!new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)) {
      throw new ApiError(`A ${PIN_LENGTH}-digit staff PIN is required for a revoke request`, 400)
    }
    const reason = String(body?.reason ?? '').trim()
    if (!reason) throw new ApiError('A revoke reason is required (audit trail)', 400)
    if (reason.length > REASON_MAX) {
      throw new ApiError(`Reason too long (max ${REASON_MAX} chars)`, 400)
    }
    const operator = String(body?.operator ?? '').trim().slice(0, 60) || null

    // staff PIN authorization — an active account with this exact PIN (the
    // same authority as the in-POS payment revoke; the authorizer is named
    // in the audit trail)
    const pinUser = await db.user.findFirst({ where: { pin, active: true } })
    if (!pinUser) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      throw new ApiError('Invalid staff PIN', 401)
    }

    // ── resolve the mazaj delivery ──
    const externalRef = `mazaj:${externalId}`
    const standalone = await db.order.findUnique({
      where: { externalRef },
      include: ORDER_INCLUDE,
    })

    if (standalone) {
      // ── standalone check (the whole order is mazaj's) ──
      if (standalone.status === 'cancelled' || standalone.status === 'revoked') {
        // idempotent replay — mazaj retries must never double-apply
        return NextResponse.json({
          order: serializeOrder(standalone),
          revoke: {
            mode: standalone.status === 'cancelled' ? 'cancelled' : 'payment-revoked',
            reason,
            authorizedBy: pinUser.name,
          },
          duplicate: true,
        })
      }
      if (standalone.status === 'merged') {
        throw new ApiError(
          'This shisha order was merged into another check — revoke it from the POS on the target check',
          409,
        )
      }

      if (standalone.status === 'paid') {
        // ── paid → payment revoke (r32 revoke-route semantics) ──
        let paidTotal = 0
        let refundedTotal = 0
        for (const p of standalone.payments) {
          if (p.amount >= 0) paidTotal += p.amount
          else refundedTotal += -p.amount
        }
        const capacity = round2(paidTotal - refundedTotal)
        if (capacity <= 0) {
          throw new ApiError('Nothing left to revoke — this check was already fully reversed', 409)
        }
        const method =
          standalone.payments
            .filter((p) => p.amount > 0)
            .sort((a, b) => b.amount - a.amount)[0]?.method ?? 'cash'

        const payment = await withWriteLock(() =>
          db.$transaction(async (tx) => {
            const createdPayment = await tx.payment.create({
              data: {
                orderId: standalone.id,
                method,
                amount: -capacity,
                tip: 0,
                reference: `mazaj-revoke: ${reason}`,
              },
            })
            await emitOutboxEvent(tx, {
              entity: 'Payment',
              entityId: createdPayment.id,
              operation: 'create',
              row: createdPayment,
            })
            const revokedOrder = await tx.order.update({
              where: { id: standalone.id },
              data: { status: 'revoked' },
            })
            await emitOutboxEvent(tx, {
              entity: 'Order',
              entityId: standalone.id,
              operation: 'update',
              row: revokedOrder,
            })
            return createdPayment
          }),
        )
        await logAudit({
          user: null,
          action: 'integration.mazajRevoke',
          entity: 'order',
          entityId: standalone.id,
          details: `mazaj revoke ${externalId} → payment revoked on #${standalone.id} (−${capacity.toFixed(2)} EGP, ${method}) — authorized by ${pinUser.name} (staff PIN)${operator ? `, mazaj operator: ${operator}` : ''} — ${reason}`,
        })
        const fresh = await db.order.findUniqueOrThrow({
          where: { id: standalone.id },
          include: ORDER_INCLUDE,
        })
        return NextResponse.json({
          order: serializeOrder(fresh),
          revoke: {
            mode: 'payment-revoked',
            paymentId: payment.id,
            amount: capacity,
            method,
            reason,
            authorizedBy: pinUser.name,
          },
          duplicate: false,
        })
      }

      // ── open / deferred → organic cancel (cancel-route semantics) ──
      await withWriteLock(() =>
        db.$transaction(async (tx) => {
          const saved = await tx.order.update({
            where: { id: standalone.id },
            data: { status: 'cancelled', closedAt: new Date() },
          })
          await emitOutboxEvent(tx, {
            entity: 'Order',
            entityId: standalone.id,
            operation: 'update',
            row: saved,
          })
        }),
      )
      // release every seating table (primary + merged extras) exactly like
      // the cancel route
      for (const tableId of orderTableIds(standalone)) {
        await freeTableIfUnused(tableId, standalone.id)
      }
      await logAudit({
        user: null,
        action: 'integration.mazajRevoke',
        entity: 'order',
        entityId: standalone.id,
        details: `mazaj revoke ${externalId} → cancelled #${standalone.id} (EGP ${round2(standalone.totalAmount).toFixed(2)}${
          standalone.table ? `, table ${standalone.table.name}` : ', takeaway'
        }) — authorized by ${pinUser.name} (staff PIN)${operator ? `, mazaj operator: ${operator}` : ''} — ${reason}`,
      })
      const fresh = await db.order.findUniqueOrThrow({
        where: { id: standalone.id },
        include: ORDER_INCLUDE,
      })
      return NextResponse.json({
        order: serializeOrder(fresh),
        revoke: {
          mode: 'cancelled',
          reason,
          authorizedBy: pinUser.name,
        },
        duplicate: false,
      })
    }

    // ── add-to-check delivery (items live on a shared table check) ──
    const seenKey = `${MAZAJ_SEEN_PREFIX}mazaj:${externalId}`
    const seenRow = await db.appSetting.findUnique({ where: { key: seenKey } })
    if (!seenRow) {
      throw new ApiError(`No mazaj order found for externalId "${externalId}"`, 404)
    }
    const seen = JSON.parse(seenRow.value) as { orderId?: number; itemIds?: number[] }
    if (seen.orderId == null) {
      throw new ApiError(`No mazaj order found for externalId "${externalId}"`, 404)
    }
    const checkOrder = await db.order.findUnique({
      where: { id: seen.orderId },
      include: ORDER_INCLUDE,
    })
    if (!checkOrder) {
      throw new ApiError(`The check this shisha order landed on (#${seen.orderId}) no longer exists`, 404)
    }
    if (checkOrder.status !== 'open') {
      throw new ApiError(
        `This shisha order landed on check #${checkOrder.id} which is ${checkOrder.status} — a closed check must be revoked from the POS by the cashier (their own PIN)`,
        409,
      )
    }

    const itemIds = (seen.itemIds ?? []).filter((id) => Number.isInteger(id))
    if (itemIds.length === 0) {
      throw new ApiError('The delivery ledger has no item ids recorded — cannot resolve the shisha lines', 409)
    }
    const stillPresent = checkOrder.items.filter((i) => itemIds.includes(i.id))
    if (stillPresent.length === 0) {
      // every line was already removed — idempotent replay
      return NextResponse.json({
        order: serializeOrder(checkOrder),
        revoke: {
          mode: 'items-removed',
          removedItemIds: [],
          reason,
          authorizedBy: pinUser.name,
        },
        duplicate: true,
      })
    }

    await withWriteLock(() =>
      db.$transaction(async (tx) => {
        for (const item of stillPresent) {
          await tx.orderItem.delete({ where: { id: item.id } })
          await emitOutboxEvent(tx, {
            entity: 'OrderItem',
            entityId: item.id,
            operation: 'delete',
            row: item,
          })
        }
        await recomputeTotals(checkOrder.id, tx)
      }),
    )
    await logAudit({
      user: null,
      action: 'integration.mazajRevoke',
      entity: 'order',
      entityId: checkOrder.id,
      details: `mazaj revoke ${externalId} → removed ${stillPresent.length} shisha line(s) from check #${checkOrder.id} (table ${checkOrder.table?.name ?? '—'}) — authorized by ${pinUser.name} (staff PIN)${operator ? `, mazaj operator: ${operator}` : ''} — ${reason}`,
    })
    const fresh = await db.order.findUniqueOrThrow({
      where: { id: checkOrder.id },
      include: ORDER_INCLUDE,
    })
    return NextResponse.json({
      order: serializeOrder(fresh),
      revoke: {
        mode: 'items-removed',
        removedItemIds: stillPresent.map((i) => i.id),
        reason,
        authorizedBy: pinUser.name,
      },
      duplicate: false,
    })
  } catch (err) {
    return errorResponse(err)
  }
}
