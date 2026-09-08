// ─── Audit log helper ────────────────────────────────────────────────
// Fire-and-forget audit trail for sensitive actions. NEVER throws into
// the calling route: logging failures are swallowed after being printed
// to the server console so the business operation always succeeds.

import { db } from '@/lib/db'
import type { SessionPayload } from '@/lib/auth'

export const AUDIT_ACTIONS = [
  'order.create',
  'order.payment',
  'order.defer',
  'order.deferSettle',
  'order.cancel',
  'order.transfer',
  'order.merge',
  'order.itemTransfer',
  'order.itemDelete',
  'table.bus',
  'table.clean',
  'settings.update',
  'user.create',
  'user.update',
  'user.delete',
  'role.create',
  'role.update',
  'role.delete',
  'inventory.adjust',
] as const
export type AuditAction = (typeof AUDIT_ACTIONS)[number]

export type AuditInput = {
  /** the session user performing the action (name snapshotted) */
  user?: Pick<SessionPayload, 'userId' | 'name'> | null
  action: AuditAction
  entity: 'order' | 'table' | 'payment' | 'settings' | 'user' | 'role' | 'inventory'
  entityId?: number | null
  /** short human-readable EN summary shown in the Activity log */
  details?: string | null
}

/** Record an audit entry (fire-and-forget; never rejects). */
export async function logAudit(input: AuditInput): Promise<void> {
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
