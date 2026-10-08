// ─── Audit log helper ────────────────────────────────────────────────
// Fire-and-forget audit trail for sensitive actions. NEVER throws into
// the calling route: logging failures are swallowed after being printed
// to the server console so the business operation always succeeds.

import { db } from '@/lib/db'
import type { SessionPayload } from '@/lib/auth'
import type { Prisma } from '@prisma/client'
import { emitOutboxEvent } from '@/lib/hybrid-sync/outbox'

import { AUDIT_ACTIONS } from './audit-actions'
import type { AuditAction } from './audit-actions'

export { AUDIT_ACTIONS } from './audit-actions'
export type { AuditAction } from './audit-actions'

export type AuditInput = {
  /** the session user performing the action (name snapshotted; R19 person
   *  fields picked up automatically when the session has one selected) */
  user?: Pick<SessionPayload, 'userId' | 'name' | 'personId' | 'personName'> | null
  action: AuditAction
  entity:
    | 'order'
    | 'table'
    | 'payment'
    | 'settings'
    | 'user'
    | 'role'
    | 'person'
    | 'inventory'
    | 'vision'
    | 'reservation'
    | 'product'
    | 'customer'
    | 'integration'
    | 'invoice'
    | 'system'
    // R17: Foodics/Odoo-level modules
    | 'supplier'
    | 'purchase'
    | 'stockcount'
    | 'waste'
    | 'promotion'
    | 'payroll'
    // R23: scheduled reports (daily digest)
    | 'report'
  entityId?: number | null
  /** short human-readable EN summary shown in the Activity log */
  details?: string | null
  /** R19: override the session person for this entry (rare — e.g. system
   *  actions performed on behalf of a person). Defaults to the session's
   *  selected person. */
  personId?: number | null
  personName?: string | null
}

/** Record an audit entry (fire-and-forget; never rejects).
 *
 * R39 hybrid sync: the audit row + its outbox event commit in ONE
 * transaction so the activity trail reaches the cloud replica and every
 * other terminal (AuditLog is append-only — inserts only, idempotent by
 * eventId). Verified r39: no call site currently runs inside a caller
 * transaction; the optional `tx` param keeps it that way for future
 * in-transaction callers (pass the ambient tx instead of letting this
 * helper open a nested one, which Prisma forbids). */
export async function logAudit(
  input: AuditInput,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  const write = async (handle: Prisma.TransactionClient) => {
    const row = await handle.auditLog.create({
      data: {
        userId: input.user?.userId ?? null,
        userName: input.user?.name ?? 'system',
        // R19 person-level attribution (null on sessions without a selected
        // person and on all rows predating R19 — never fabricated)
        personId: input.personId !== undefined ? input.personId : (input.user?.personId ?? null),
        personName:
          input.personName !== undefined ? input.personName : (input.user?.personName ?? null),
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? null,
        details: input.details ?? null,
      },
    })
    await emitOutboxEvent(handle, {
      entity: 'AuditLog',
      entityId: row.id,
      operation: 'create',
      row,
    })
  }
  try {
    if (tx) {
      await write(tx)
    } else {
      await db.$transaction(write)
    }
  } catch (err) {
    console.error('[audit-log] failed to record', input.action, err)
  }
}
