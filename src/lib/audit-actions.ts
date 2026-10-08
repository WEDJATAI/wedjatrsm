// ─── Audit action vocabulary (client-safe leaf module) ───────────────
// r49: split out of @/lib/audit so client components (the Admin activity
// view) can import the action list WITHOUT dragging the Prisma client +
// driver adapters (pg/libsql → node:fs/dns) into the browser bundle.
// The server-side audit.ts re-exports everything from here — zero API
// changes for existing importers.

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
  // r34: delete-user — permanent removal vs archive-tombstone (history kept)
  'user.hardDelete',
  'user.archiveDelete',
  'role.create',
  'role.update',
  'role.delete',
  // r34: permanent role removal (no users assigned)
  'role.hardDelete',
  // R19: person-level tracking — who is using each account
  'person.create',
  'person.update',
  // R19: guest check issued/presented by a specific person
  'order.checkIssue',
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
  // r46: mazaj ↔ RSM bridge — catalog & availability mirror pushes
  'integration.mazajCatalog',
  'integration.mazajInventory',
  'order.externalCreate',
  // R17: refunds — negative-payment issuance against paid checks
  'order.refund',
  // r32: revoke a payment after it was made (cashier PIN + reason)
  'order.revoke',
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
  'desktop.agentDownload',
  // R39: payroll source data — clock actions on the kiosk/PIN routes
  'attendance.clockIn',
  'attendance.clockOut',
  // R39: menu/price changes (money-relevant, previously unaudited)
  'product.create',
  'product.update',
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
  // R23: cloud ops — scheduled jobs (Inngest / Vercel cron)
  'report.dailyDigest',
  'alert.staleOrders',
  'replication.tursoSync',
  // R27: manager sign-in — the super admin changed his own PIN
  'manager.pinChange',
  // p11-d: developer sign-in — the developer changed his own PIN
  'developer.pinChange',
  // R30: local-first hybrid sync — device registry + staged restore
  'hybrid.deviceCreate',
  'hybrid.deviceUpdate',
  'hybrid.deviceSelfEnroll',
  'backup.restoreStage',
] as const

export type AuditAction = (typeof AUDIT_ACTIONS)[number]
