// ─── Audit log helper ────────────────────────────────────────────────
// Fire-and-forget audit trail for sensitive actions. NEVER throws into
// the calling route: logging failures are swallowed after being printed
// to the server console so the business operation always succeeds.

import { db } from '@/lib/db'
import type { SessionPayload } from '@/lib/auth'

export const AUDIT_ACTIONS = [
  'order.create',
  'order.payment',
  'order.update',
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
  // R9: AI vision — cameras/zones config, human-confirmed movements,
  // overrides and edge settings (append-only trail)
  'vision.cameraCreate',
  'vision.cameraUpdate',
  'vision.cameraDelete',
  'vision.zoneCreate',
  'vision.zoneUpdate',
  'vision.zoneDelete',
  'vision.movementConfirm',
  'vision.movementReject',
  'vision.movementUndo',
  'vision.override',
  'vision.configUpdate',
  'vision.ingestKeyRotate',
  'vision.simulate',
  // R11: reservations — booking board actions
  'reservation.create',
  'reservation.update',
  'reservation.seat',
  'reservation.cancel',
  'reservation.noShow',
  // R13: menu availability, customers & loyalty, integrations, invoices
  'product.soldOut',
  'customer.create',
  'customer.update',
  'customer.pointsAdjust',
  'loyalty.redeem',
  'loyalty.earn',
  'integration.update',
  'integration.webhook',
  'order.externalCreate',
  // R17: refunds — negative-payment issuance against paid checks
  'order.refund',
  'invoice.export',
  // R14: data safety — consistent snapshots (auto/manual/download)
  'backup.auto',
  'backup.manual',
  'backup.download',
  // R15: offline-first Windows deployment — sync bundles + desktop package
  'sync.export',
  'sync.import',
  'sync.push',
  'sync.settings',
  'desktop.package',
  // R17: Foodics/Odoo-level modules — purchasing, counts, waste, promos, payroll
  'supplier.create',
  'supplier.update',
  'supplier.delete',
  'purchase.create',
  'purchase.confirm',
  'purchase.receive',
  'purchase.cancel',
  'stockcount.create',
  'stockcount.saveCounts',
  'stockcount.post',
  'stockcount.cancel',
  'waste.log',
  'promotion.create',
  'promotion.update',
  'promotion.delete',
  'payroll.rateUpdate',
] as const
export type AuditAction = (typeof AUDIT_ACTIONS)[number]

export type AuditInput = {
  /** the session user performing the action (name snapshotted) */
  user?: Pick<SessionPayload, 'userId' | 'name'> | null
  action: AuditAction
  entity:
    | 'order'
    | 'table'
    | 'payment'
    | 'settings'
    | 'user'
    | 'role'
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
