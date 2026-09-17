/**
 * R15 sync engine — offline-first one-way merge for Windows deployments.
 * R21: expanded from 9 to 18 operational tables (purchasing, stock counts,
 * waste, promotions, persons, custom roles now sync too).
 *
 * Model: a Windows instance runs the FULL platform 100% locally (SQLite at
 * db/custom.db). Whenever it is online, it can EXPORT its operational
 * updates (orders, payments, customers, attendance, cash entries, inventory
 * movements, reservations, audit rows, suppliers, purchase orders + lines,
 * stock counts + lines, waste logs, promotions, persons, custom roles) as a
 * `rsm-sync/1` bundle and PUSH them to a hosted master instance, which
 * merges them via /api/sync/import.
 *
 * Honest semantics (documented, by design):
 *  - This is a ONE-WAY merge: the sender's rows always win (last-writer-wins
 *    by bundle generation time), nothing is ever deleted, and rows whose FK
 *    parents are missing on the receiving side are skipped — never fatal.
 *  - `lastExportAt` marks the delta watermark. Delta bundles carry every row
 *    created after it (and, since R21, every row UPDATED after it for tables
 *    with @updatedAt tracking) PLUS all currently-open orders (with their
 *    items and payments) so the receiving side always sees live check state.
 *    persons + customRoles (tiny reference tables) ride every bundle in full.
 *  - Catalog/reference data (products, categories, users, tables, floors)
 *    does NOT sync — it ships with the Windows package snapshot.
 *
 * Settings live in the existing AppSetting key/value store (same pattern as
 * the integrations route): sync.targetUrl, sync.autoExport, sync.lastExportAt,
 * sync.lastPushAt, sync.key (created lazily, crypto-random).
 */
import { randomBytes } from 'node:crypto'

import { db } from '@/lib/db'
import type { Prisma } from '@prisma/client'
import type { SyncBundle, SyncImportSummary, SyncPendingCounts, SyncSettingsDTO } from '@/lib/types'

export const SYNC_FORMAT = 'rsm-sync/1'
export const SYNC_SOURCE = 'rsm'

export const SYNC_KEY_TARGET_URL = 'sync.targetUrl'
export const SYNC_KEY_AUTO_EXPORT = 'sync.autoExport'
export const SYNC_KEY_LAST_EXPORT = 'sync.lastExportAt'
export const SYNC_KEY_LAST_PUSH = 'sync.lastPushAt'
export const SYNC_KEY = 'sync.key'

// ─── settings helpers (same pattern as /api/integrations) ─────────────

async function readSetting(key: string): Promise<string | null> {
  const row = await db.appSetting.findUnique({ where: { key } })
  return row?.value ?? null
}

async function upsertSetting(key: string, value: string): Promise<void> {
  await db.appSetting.upsert({ where: { key }, update: { value }, create: { key, value } })
}

// ─── raw state + DTO ──────────────────────────────────────────────────

export type SyncRawState = {
  targetUrl: string
  autoExport: boolean
  lastExportAt: Date | null
  lastPushAt: Date | null
  /** full sync key — NEVER leave the server; only masked forms are exposed */
  key: string
}

/** Read all sync settings, creating the sync key lazily on first access. */
export async function readSyncState(): Promise<SyncRawState> {
  let key = await readSetting(SYNC_KEY)
  if (!key) {
    key = randomBytes(24).toString('hex')
    await upsertSetting(SYNC_KEY, key)
  }
  const [targetUrl, autoExport, lastExport, lastPush] = await Promise.all([
    readSetting(SYNC_KEY_TARGET_URL),
    readSetting(SYNC_KEY_AUTO_EXPORT),
    readSetting(SYNC_KEY_LAST_EXPORT),
    readSetting(SYNC_KEY_LAST_PUSH),
  ])
  const parseDate = (raw: string | null): Date | null => {
    if (!raw) return null
    const ms = Date.parse(raw)
    return Number.isFinite(ms) ? new Date(ms) : null
  }
  return {
    targetUrl: targetUrl ?? '',
    autoExport: autoExport === 'true',
    lastExportAt: parseDate(lastExport),
    lastPushAt: parseDate(lastPush),
    key,
  }
}

/** First 4 + '…' + last 4 — the only form in which the key is ever shown. */
export function maskSyncKey(key: string): string {
  if (key.length <= 8) return `${key.slice(0, 2)}…`
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}

/**
 * Rows per table that would ride the next delta (all rows when the watermark
 * is unset). R21: mutating tables (orders + the 8 R17/R19 tables) count rows
 * created OR updated after the watermark — @updatedAt columns make lifecycle
 * transitions (draft→ordered, open→posted, open→paid …) visible to deltas.
 */
export async function computePendingCounts(lastExportAt: Date | null): Promise<SyncPendingCounts> {
  const where = lastExportAt ? { createdAt: { gt: lastExportAt } } : undefined
  // created OR updated after the watermark — used by every table whose rows
  // mutate after creation (R21 @updatedAt tracking)
  const mutatedWhere = lastExportAt
    ? { OR: [{ createdAt: { gt: lastExportAt } }, { updatedAt: { gt: lastExportAt } }] }
    : undefined
  // orders additionally keep the live-state carve-out (open orders always ride)
  const orderWhere = lastExportAt
    ? { OR: [{ createdAt: { gt: lastExportAt } }, { updatedAt: { gt: lastExportAt } }, { status: 'open' as const }] }
    : undefined
  // items/payments ride when new OR belonging to an open order (live checks)
  const itemWhere = lastExportAt
    ? { OR: [{ createdAt: { gt: lastExportAt } }, { order: { status: 'open' as const } }] }
    : undefined
  const [
    orders, orderItems, payments, customers, attendance, cashEntries, inventoryTransactions, reservations, auditLogs,
    suppliers, purchaseOrders, purchaseOrderItems, stockCounts, stockCountLines, wasteLogs, promotions, persons, customRoles,
  ] = await Promise.all([
    db.order.count({ where: orderWhere }),
    db.orderItem.count({ where: itemWhere }),
    db.payment.count({ where: itemWhere }),
    db.customer.count({ where }),
    db.attendance.count({ where }),
    db.cashDrawerEntry.count({ where }),
    db.inventoryTransaction.count({ where }),
    db.reservation.count({ where }),
    db.auditLog.count({ where }),
    // R21 tables
    db.supplier.count({ where: mutatedWhere }),
    db.purchaseOrder.count({ where: mutatedWhere }),
    db.purchaseOrderItem.count({ where: mutatedWhere }),
    db.stockCount.count({ where: mutatedWhere }),
    db.stockCountLine.count({ where: mutatedWhere }),
    db.wasteLog.count({ where }),
    db.promotion.count({ where: mutatedWhere }),
    db.person.count({ where: mutatedWhere }),
    db.customRole.count({ where: mutatedWhere }),
  ])
  const counts: Omit<SyncPendingCounts, 'total'> = {
    orders,
    orderItems,
    payments,
    customers,
    attendance,
    cashEntries,
    inventoryTransactions,
    reservations,
    auditLogs,
    suppliers,
    purchaseOrders,
    purchaseOrderItems,
    stockCounts,
    stockCountLines,
    wasteLogs,
    promotions,
    persons,
    customRoles,
  }
  return { ...counts, total: Object.values(counts).reduce((sum, n) => sum + n, 0) }
}

/** Full Sync Center status DTO (key masked, pending recomputed). */
export async function getSyncStatus(): Promise<SyncSettingsDTO> {
  const state = await readSyncState()
  const pending = await computePendingCounts(state.lastExportAt)
  return {
    targetUrl: state.targetUrl,
    autoExport: state.autoExport,
    lastExportAt: state.lastExportAt?.toISOString() ?? null,
    lastPushAt: state.lastPushAt?.toISOString() ?? null,
    syncKeyMasked: maskSyncKey(state.key),
    pending,
  }
}

/** Update settings (used by the settings route; empty values clear). */
export async function writeSyncSettings(input: {
  targetUrl?: string
  autoExport?: boolean
  rotateKey?: boolean
  /**
   * R21: explicitly SET the sync key (e.g. paste the master's key on a
   * Windows instance so it can push — closes the README-WINDOWS flow that
   * previously had no UI). Rotate generates a fresh key; setKey installs a
   * known one. Empty string is rejected by the route.
   */
  setKey?: string
}): Promise<void> {
  if (input.targetUrl !== undefined) await upsertSetting(SYNC_KEY_TARGET_URL, input.targetUrl)
  if (input.autoExport !== undefined) await upsertSetting(SYNC_KEY_AUTO_EXPORT, String(input.autoExport))
  if (input.rotateKey) await upsertSetting(SYNC_KEY, randomBytes(24).toString('hex'))
  if (input.setKey !== undefined) await upsertSetting(SYNC_KEY, input.setKey)
}

/** Advance the delta watermark (call only after a successful export/push). */
export async function markSyncExported(at: Date): Promise<void> {
  await upsertSetting(SYNC_KEY_LAST_EXPORT, at.toISOString())
}

export async function markSyncPushed(at: Date): Promise<void> {
  await upsertSetting(SYNC_KEY_LAST_PUSH, at.toISOString())
}

// ─── export (bundle builder) ──────────────────────────────────────────

/** Date → ISO string; Prisma Decimal-like objects → number; primitives as-is. */
function serializeValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (value === null || value === undefined) return null
  if (typeof value === 'object' && typeof (value as { toNumber?: unknown }).toNumber === 'function') {
    return (value as { toNumber: () => number }).toNumber()
  }
  return value
}

function serializeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(row)) out[field] = serializeValue(value)
  return out
}

export type BuiltBundle = {
  bundle: SyncBundle
  /**
   * Timestamp captured BEFORE reading the rows — marking lastExportAt with
   * it guarantees nothing read during the build is silently skipped by the
   * next delta (rows created after it simply stay pending).
   */
  exportedAt: Date
}

/**
 * Build a sync bundle of the 18 operational tables (9 original + 9 added in
 * R21: suppliers, purchase orders + lines, stock counts + lines, waste logs,
 * promotions, persons, custom roles).
 *  - delta: rows created (or, for mutating tables, updated) after the
 *    lastExportAt watermark — all rows when unset — PLUS every open order
 *    "in full" (items + payments) so the receiving side always gets live
 *    check state. persons + customRoles are tiny reference tables that
 *    orders/roles depend on, so they ride EVERY bundle in full (FK safety).
 *  - full: every row of all 18 tables.
 */
export async function buildSyncBundle(mode: 'delta' | 'full'): Promise<BuiltBundle> {
  const exportedAt = new Date()
  const since = mode === 'delta' ? (await readSyncState()).lastExportAt : null

  // Plain deltas (append-mostly tables): created after the watermark.
  const deltaWhere = since ? { createdAt: { gt: since } } : undefined
  // Mutating tables (R21 @updatedAt tracking): created OR updated after it.
  const mutatedWhere = since
    ? { OR: [{ createdAt: { gt: since } }, { updatedAt: { gt: since } }] }
    : undefined
  // Orders: new/updated rows PLUS the live-state carve-out (open orders).
  const orderDeltaWhere = since
    ? { OR: [{ createdAt: { gt: since } }, { updatedAt: { gt: since } }, { status: 'open' as const }] }
    : undefined
  // Items/payments: new rows OR anything belonging to a currently-open order.
  const itemDeltaWhere = since
    ? { OR: [{ createdAt: { gt: since } }, { order: { status: 'open' as const } }] }
    : undefined

  const [
    customers, orders, orderItems, payments, attendance, cashEntries, inventoryTransactions, reservations, auditLogs,
    suppliers, purchaseOrders, purchaseOrderItems, stockCounts, stockCountLines, wasteLogs, promotions, persons, customRoles,
  ] = await Promise.all([
    db.customer.findMany({ where: deltaWhere }),
    db.order.findMany({ where: orderDeltaWhere }),
    db.orderItem.findMany({ where: itemDeltaWhere }),
    db.payment.findMany({ where: itemDeltaWhere }),
    db.attendance.findMany({ where: deltaWhere }),
    db.cashDrawerEntry.findMany({ where: deltaWhere }),
    db.inventoryTransaction.findMany({ where: deltaWhere }),
    db.reservation.findMany({ where: deltaWhere }),
    db.auditLog.findMany({ where: deltaWhere }),
    // R21 tables
    db.supplier.findMany({ where: mutatedWhere }),
    db.purchaseOrder.findMany({ where: mutatedWhere }),
    db.purchaseOrderItem.findMany({ where: mutatedWhere }),
    db.stockCount.findMany({ where: mutatedWhere }),
    db.stockCountLine.findMany({ where: mutatedWhere }),
    db.wasteLog.findMany({ where: deltaWhere }),
    db.promotion.findMany({ where: mutatedWhere }),
    // tiny reference tables — always ride in full so order.checkIssuedByPersonId
    // and role references never dangle on the receiving side
    db.person.findMany(),
    db.customRole.findMany(),
  ])

  // Prisma returns rows in arbitrary order for bulk finds — sort by id for
  // deterministic, diffable bundles (self-import stays idempotent either way).
  const byId = (a: { id: number }, b: { id: number }) => a.id - b.id
  for (const list of [customers, orders, orderItems, payments, attendance, cashEntries, inventoryTransactions, reservations, auditLogs,
    suppliers, purchaseOrders, purchaseOrderItems, stockCounts, stockCountLines, wasteLogs, promotions, persons, customRoles]) {
    list.sort(byId)
  }

  const data = {
    customers: customers.map(serializeRow),
    orders: orders.map(serializeRow),
    orderItems: orderItems.map(serializeRow),
    payments: payments.map(serializeRow),
    attendance: attendance.map(serializeRow),
    cashEntries: cashEntries.map(serializeRow),
    inventoryTransactions: inventoryTransactions.map(serializeRow),
    reservations: reservations.map(serializeRow),
    auditLogs: auditLogs.map(serializeRow),
    // R21 tables
    suppliers: suppliers.map(serializeRow),
    purchaseOrders: purchaseOrders.map(serializeRow),
    purchaseOrderItems: purchaseOrderItems.map(serializeRow),
    stockCounts: stockCounts.map(serializeRow),
    stockCountLines: stockCountLines.map(serializeRow),
    wasteLogs: wasteLogs.map(serializeRow),
    promotions: promotions.map(serializeRow),
    persons: persons.map(serializeRow),
    customRoles: customRoles.map(serializeRow),
  }

  const bundle: SyncBundle = {
    format: SYNC_FORMAT,
    mode,
    since: since?.toISOString() ?? null,
    generatedAt: exportedAt.toISOString(),
    source: SYNC_SOURCE,
    counts: Object.fromEntries(Object.entries(data).map(([table, rows]) => [table, rows.length])),
    data,
  }
  return { bundle, exportedAt }
}

// ─── import (merge) ───────────────────────────────────────────────────

/** Defensive coercers — a malformed row degrades to a skip, never a crash. */
function toId(value: unknown): number | null {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}
function toIntOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : null
}
function toIntOr(value: unknown, fallback: number): number {
  return toIntOrNull(value) ?? fallback
}
function toNumOr(value: unknown, fallback: number): number {
  if (value === null || value === undefined || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}
function toStr(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return String(value)
}
function toBoolOr(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return fallback
}
function toDate(value: unknown): Date | null {
  if (value === null || value === undefined || value === '') return null
  const d = new Date(String(value))
  return Number.isNaN(d.getTime()) ? null : d
}
function toNumOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

// Bundle rows use the Prisma client field names (camelCase), so the mapped
// objects feed straight into upsert(). The intersection with { id: number }
// makes the primary key required for the generic importer below.
type CustomerRow = Prisma.CustomerUncheckedCreateInput & { id: number }
type OrderRow = Prisma.OrderUncheckedCreateInput & { id: number }
type OrderItemRow = Prisma.OrderItemUncheckedCreateInput & { id: number }
type PaymentRow = Prisma.PaymentUncheckedCreateInput & { id: number }
type AttendanceRow = Prisma.AttendanceUncheckedCreateInput & { id: number }
type CashDrawerEntryRow = Prisma.CashDrawerEntryUncheckedCreateInput & { id: number }
type InventoryTransactionRow = Prisma.InventoryTransactionUncheckedCreateInput & { id: number }
type ReservationRow = Prisma.ReservationUncheckedCreateInput & { id: number }
type AuditLogRow = Prisma.AuditLogUncheckedCreateInput & { id: number }
// R21 tables
type SupplierRow = Prisma.SupplierUncheckedCreateInput & { id: number }
type PurchaseOrderRow = Prisma.PurchaseOrderUncheckedCreateInput & { id: number }
type PurchaseOrderItemRow = Prisma.PurchaseOrderItemUncheckedCreateInput & { id: number }
type StockCountRow = Prisma.StockCountUncheckedCreateInput & { id: number }
type StockCountLineRow = Prisma.StockCountLineUncheckedCreateInput & { id: number }
type WasteLogRow = Prisma.WasteLogUncheckedCreateInput & { id: number }
type PromotionRow = Prisma.PromotionUncheckedCreateInput & { id: number }
type PersonRow = Prisma.PersonUncheckedCreateInput & { id: number }
type CustomRoleRow = Prisma.CustomRoleUncheckedCreateInput & { id: number }

function normalizeCustomer(row: Record<string, unknown>): CustomerRow | null {
  const id = toId(row.id)
  if (id === null) return null
  return {
    id,
    name: toStr(row.name) ?? '',
    phone: toStr(row.phone),
    visits: toIntOr(row.visits, 0),
    points: toNumOr(row.points, 0),
    totalSpent: toNumOr(row.totalSpent, 0),
    lastVisitAt: toDate(row.lastVisitAt),
    notes: toStr(row.notes),
    active: toBoolOr(row.active, true),
    createdAt: toDate(row.createdAt) ?? new Date(),
  }
}

function normalizeOrder(row: Record<string, unknown>): OrderRow | null {
  const id = toId(row.id)
  if (id === null) return null
  return {
    id,
    tableId: toIntOrNull(row.tableId),
    userId: toIntOrNull(row.userId),
    status: toStr(row.status) ?? 'open',
    orderType: toStr(row.orderType) ?? 'dinein',
    deliveryPhone: toStr(row.deliveryPhone),
    deliveryAddress: toStr(row.deliveryAddress),
    customerId: toIntOrNull(row.customerId),
    pointsEarned: toNumOr(row.pointsEarned, 0),
    pointsRedeemed: toNumOr(row.pointsRedeemed, 0),
    externalRef: toStr(row.externalRef),
    guests: toIntOr(row.guests, 1),
    subtotalAmount: toNumOr(row.subtotalAmount, 0),
    totalAmount: toNumOr(row.totalAmount, 0),
    discountAmount: toNumOr(row.discountAmount, 0),
    taxAmount: toNumOr(row.taxAmount, 0),
    serviceTaxAmount: toNumOr(row.serviceTaxAmount, 0),
    discountReason: toStr(row.discountReason),
    clientName: toStr(row.clientName),
    extraTableIds: toStr(row.extraTableIds),
    createdAt: toDate(row.createdAt) ?? new Date(),
    closedAt: toDate(row.closedAt),
    // R19 fields (R21 fix: previously dropped on import — check attribution was
    // silently lost on every merge)
    checkIssuedByPersonId: toIntOrNull(row.checkIssuedByPersonId),
    checkIssuedAt: toDate(row.checkIssuedAt),
    updatedAt: toDate(row.updatedAt),
  }
}

function normalizeOrderItem(row: Record<string, unknown>): OrderItemRow | null {
  const id = toId(row.id)
  const orderId = toIntOrNull(row.orderId)
  if (id === null || orderId === null) return null
  return {
    id,
    orderId,
    productId: toIntOrNull(row.productId),
    quantity: toNumOr(row.quantity, 1),
    unitPrice: toNumOr(row.unitPrice, 0),
    notes: toStr(row.notes),
    course: toStr(row.course) ?? 'main',
    status: toStr(row.status) ?? 'new',
    selectedModifiers: toStr(row.selectedModifiers),
    createdAt: toDate(row.createdAt) ?? new Date(),
  }
}

function normalizePayment(row: Record<string, unknown>): PaymentRow | null {
  const id = toId(row.id)
  const orderId = toIntOrNull(row.orderId)
  if (id === null || orderId === null) return null
  return {
    id,
    orderId,
    method: toStr(row.method) ?? 'other',
    amount: toNumOr(row.amount, 0),
    tip: toNumOr(row.tip, 0),
    reference: toStr(row.reference),
    createdAt: toDate(row.createdAt) ?? new Date(),
  }
}

function normalizeAttendance(row: Record<string, unknown>): AttendanceRow | null {
  const id = toId(row.id)
  const userId = toIntOrNull(row.userId)
  if (id === null || userId === null) return null
  return {
    id,
    userId,
    checkInAt: toDate(row.checkInAt) ?? new Date(),
    checkOutAt: toDate(row.checkOutAt),
    lateMinutes: toIntOr(row.lateMinutes, 0),
    createdAt: toDate(row.createdAt) ?? new Date(),
  }
}

function normalizeCashDrawerEntry(row: Record<string, unknown>): CashDrawerEntryRow | null {
  const id = toId(row.id)
  const sessionId = toIntOrNull(row.sessionId)
  if (id === null || sessionId === null) return null
  return {
    id,
    sessionId,
    type: toStr(row.type) ?? 'paid_in',
    amount: toNumOr(row.amount, 0),
    note: toStr(row.note),
    userId: toIntOrNull(row.userId),
    createdAt: toDate(row.createdAt) ?? new Date(),
  }
}

function normalizeInventoryTransaction(row: Record<string, unknown>): InventoryTransactionRow | null {
  const id = toId(row.id)
  const productId = toIntOrNull(row.productId)
  if (id === null || productId === null) return null
  return {
    id,
    productId,
    quantityChange: toNumOr(row.quantityChange, 0),
    reason: toStr(row.reason),
    orderId: toIntOrNull(row.orderId),
    createdAt: toDate(row.createdAt) ?? new Date(),
  }
}

function normalizeReservation(row: Record<string, unknown>): ReservationRow | null {
  const id = toId(row.id)
  if (id === null) return null
  return {
    id,
    customerName: toStr(row.customerName) ?? '',
    customerPhone: toStr(row.customerPhone),
    partySize: toIntOr(row.partySize, 2),
    floorPlanId: toIntOrNull(row.floorPlanId),
    tableId: toIntOrNull(row.tableId),
    reservedAt: toDate(row.reservedAt) ?? new Date(),
    status: toStr(row.status) ?? 'pending',
    notes: toStr(row.notes),
    customerId: toIntOrNull(row.customerId),
    orderId: toIntOrNull(row.orderId),
    createdBy: toStr(row.createdBy),
    createdAt: toDate(row.createdAt) ?? new Date(),
    updatedAt: toDate(row.updatedAt) ?? new Date(),
  }
}

function normalizeAuditLog(row: Record<string, unknown>): AuditLogRow | null {
  const id = toId(row.id)
  if (id === null) return null
  return {
    id,
    userId: toIntOrNull(row.userId),
    userName: toStr(row.userName) ?? 'system',
    action: toStr(row.action) ?? '',
    entity: toStr(row.entity) ?? 'system',
    entityId: toIntOrNull(row.entityId),
    details: toStr(row.details),
    // R19 person attribution (R21 fix: previously dropped on import). Snapshot
    // columns — no FK, so old bundles without them import unchanged.
    personId: toIntOrNull(row.personId),
    personName: toStr(row.personName),
    createdAt: toDate(row.createdAt) ?? new Date(),
  }
}

// ─── R21 normalizers (purchasing, stock, promotions, persons) ────────

function normalizeSupplier(row: Record<string, unknown>): SupplierRow | null {
  const id = toId(row.id)
  if (id === null) return null
  return {
    id,
    name: toStr(row.name) ?? '',
    phone: toStr(row.phone),
    email: toStr(row.email),
    address: toStr(row.address),
    notes: toStr(row.notes),
    active: toBoolOr(row.active, true),
    createdAt: toDate(row.createdAt) ?? new Date(),
    updatedAt: toDate(row.updatedAt),
  }
}

function normalizePurchaseOrder(row: Record<string, unknown>): PurchaseOrderRow | null {
  const id = toId(row.id)
  const supplierId = toIntOrNull(row.supplierId)
  const number = toStr(row.number)
  if (id === null || supplierId === null || number === null) return null
  return {
    id,
    number,
    supplierId,
    status: toStr(row.status) ?? 'draft',
    note: toStr(row.note),
    expectedAt: toDate(row.expectedAt),
    orderedAt: toDate(row.orderedAt),
    receivedAt: toDate(row.receivedAt),
    createdById: toIntOrNull(row.createdById),
    createdAt: toDate(row.createdAt) ?? new Date(),
    updatedAt: toDate(row.updatedAt),
  }
}

function normalizePurchaseOrderItem(row: Record<string, unknown>): PurchaseOrderItemRow | null {
  const id = toId(row.id)
  const purchaseOrderId = toIntOrNull(row.purchaseOrderId)
  const productId = toIntOrNull(row.productId)
  if (id === null || purchaseOrderId === null || productId === null) return null
  return {
    id,
    purchaseOrderId,
    productId,
    quantity: toNumOr(row.quantity, 0),
    receivedQuantity: toNumOr(row.receivedQuantity, 0),
    unitCost: toNumOr(row.unitCost, 0),
    createdAt: toDate(row.createdAt) ?? new Date(),
    updatedAt: toDate(row.updatedAt),
  }
}

function normalizeStockCount(row: Record<string, unknown>): StockCountRow | null {
  const id = toId(row.id)
  const number = toStr(row.number)
  if (id === null || number === null) return null
  return {
    id,
    number,
    status: toStr(row.status) ?? 'open',
    note: toStr(row.note),
    createdById: toIntOrNull(row.createdById),
    createdAt: toDate(row.createdAt) ?? new Date(),
    postedAt: toDate(row.postedAt),
    updatedAt: toDate(row.updatedAt),
  }
}

function normalizeStockCountLine(row: Record<string, unknown>): StockCountLineRow | null {
  const id = toId(row.id)
  const stockCountId = toIntOrNull(row.stockCountId)
  const productId = toIntOrNull(row.productId)
  if (id === null || stockCountId === null || productId === null) return null
  return {
    id,
    stockCountId,
    productId,
    systemQty: toNumOr(row.systemQty, 0),
    countedQty: toNumOrNull(row.countedQty),
    createdAt: toDate(row.createdAt) ?? new Date(),
    updatedAt: toDate(row.updatedAt),
  }
}

function normalizeWasteLog(row: Record<string, unknown>): WasteLogRow | null {
  const id = toId(row.id)
  const productId = toIntOrNull(row.productId)
  if (id === null || productId === null) return null
  return {
    id,
    productId,
    quantity: toNumOr(row.quantity, 0),
    costValue: toNumOr(row.costValue, 0),
    reason: toStr(row.reason) ?? 'other',
    note: toStr(row.note),
    userId: toIntOrNull(row.userId),
    createdAt: toDate(row.createdAt) ?? new Date(),
  }
}

function normalizePromotion(row: Record<string, unknown>): PromotionRow | null {
  const id = toId(row.id)
  if (id === null) return null
  return {
    id,
    name: toStr(row.name) ?? '',
    nameAr: toStr(row.nameAr),
    type: toStr(row.type) ?? 'percent',
    value: toNumOr(row.value, 0),
    scope: toStr(row.scope) ?? 'order',
    categoryId: toIntOrNull(row.categoryId),
    productId: toIntOrNull(row.productId),
    daysOfWeek: toStr(row.daysOfWeek) ?? '0,1,2,3,4,5,6',
    startTime: toStr(row.startTime),
    endTime: toStr(row.endTime),
    startDate: toDate(row.startDate),
    endDate: toDate(row.endDate),
    active: toBoolOr(row.active, true),
    createdAt: toDate(row.createdAt) ?? new Date(),
    updatedAt: toDate(row.updatedAt),
  }
}

function normalizePerson(row: Record<string, unknown>): PersonRow | null {
  const id = toId(row.id)
  const userId = toIntOrNull(row.userId)
  if (id === null || userId === null) return null
  return {
    id,
    userId,
    name: toStr(row.name) ?? '',
    active: toBoolOr(row.active, true),
    createdAt: toDate(row.createdAt) ?? new Date(),
    updatedAt: toDate(row.updatedAt),
  }
}

function normalizeCustomRole(row: Record<string, unknown>): CustomRoleRow | null {
  const id = toId(row.id)
  const name = toStr(row.name)
  if (id === null || name === null) return null
  return {
    id,
    name,
    permissions: toStr(row.permissions) ?? '',
    active: toBoolOr(row.active, true),
    createdAt: toDate(row.createdAt) ?? new Date(),
    updatedAt: toDate(row.updatedAt),
  }
}

type SyncSummaryCounts = SyncImportSummary['inserted']

function emptyCounts(): SyncSummaryCounts {
  return {
    customers: 0,
    orders: 0,
    orderItems: 0,
    payments: 0,
    attendance: 0,
    cashEntries: 0,
    inventoryTransactions: 0,
    reservations: 0,
    auditLogs: 0,
    suppliers: 0,
    purchaseOrders: 0,
    purchaseOrderItems: 0,
    stockCounts: 0,
    stockCountLines: 0,
    wasteLogs: 0,
    promotions: 0,
    persons: 0,
    customRoles: 0,
  }
}

/**
 * Generic per-table importer: normalize defensively, pre-fetch which ids
 * already exist (for inserted/updated stats), then upsert row by row inside
 * try/catch so a row with a missing FK parent or a constraint conflict is
 * counted as skipped and NEVER aborts the whole import. Upsert = update all
 * mapped columns when the id exists, create when it does not. Nothing is
 * ever deleted; the incoming row wins (last-writer-wins by bundle time).
 */
async function importTable<D extends { id: number }>(
  summary: SyncImportSummary,
  table: keyof SyncSummaryCounts,
  rows: unknown[],
  normalize: (row: Record<string, unknown>) => D | null,
  findExistingIds: (ids: number[]) => Promise<number[]>,
  upsert: (data: D) => Promise<void>,
): Promise<void> {
  const normalized: D[] = []
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      summary.skipped[table]++
      continue
    }
    const data = normalize(raw as Record<string, unknown>)
    if (data === null) {
      summary.skipped[table]++
      continue
    }
    normalized.push(data)
  }
  const ids = normalized.map((d) => d.id)
  const existing = new Set<number>(ids.length > 0 ? await findExistingIds(ids) : [])
  for (const data of normalized) {
    try {
      await upsert(data)
      if (existing.has(data.id)) summary.updated[table]++
      else summary.inserted[table]++
    } catch {
      summary.skipped[table]++
    }
  }
}

function rowsOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** Shape accepted by the importer — the route validates `format` first. */
export type SyncBundleInput = {
  format?: unknown
  mode?: unknown
  since?: unknown
  generatedAt?: unknown
  source?: unknown
  data?: unknown
}

/**
 * Merge a rsm-sync/1 bundle into THIS database (one-way merge — see the
 * module header). Tables are imported in FK order:
 * customers → customRoles → persons → orders → orderItems → payments →
 * attendance → cashEntries → inventoryTransactions → reservations →
 * suppliers → purchaseOrders → purchaseOrderItems → stockCounts →
 * stockCountLines → wasteLogs → promotions → auditLogs.
 * (R21: customRoles/persons import before orders because an order's
 * checkIssuedByPersonId must resolve — persons ride every bundle in full.)
 */
export async function importSyncBundle(bundle: SyncBundleInput): Promise<SyncImportSummary> {
  const data =
    bundle.data && typeof bundle.data === 'object' && !Array.isArray(bundle.data)
      ? (bundle.data as Record<string, unknown>)
      : {}
  const summary: SyncImportSummary = { inserted: emptyCounts(), updated: emptyCounts(), skipped: emptyCounts() }

  await importTable(summary, 'customers', rowsOf(data.customers), normalizeCustomer, async (ids) =>
    (await db.customer.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((r) => r.id),
  async (d) => {
    await db.customer.upsert({ where: { id: d.id }, create: d, update: d })
  })

  await importTable(summary, 'customRoles', rowsOf(data.customRoles), normalizeCustomRole, async (ids) =>
    (await db.customRole.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((r) => r.id),
  async (d) => {
    await db.customRole.upsert({ where: { id: d.id }, create: d, update: d })
  })

  await importTable(summary, 'persons', rowsOf(data.persons), normalizePerson, async (ids) =>
    (await db.person.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((r) => r.id),
  async (d) => {
    await db.person.upsert({ where: { id: d.id }, create: d, update: d })
  })

  await importTable(summary, 'orders', rowsOf(data.orders), normalizeOrder, async (ids) =>
    (await db.order.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((r) => r.id),
  async (d) => {
    try {
      await db.order.upsert({ where: { id: d.id }, create: d, update: d })
    } catch {
      // FK-fallback: the check-issuer person doesn't exist here (e.g. a person
      // row whose user is missing on this instance). Sync the order anyway with
      // attribution dropped rather than losing the whole order — a later full
      // bundle (or package refresh) restores attribution.
      const { checkIssuedByPersonId: _drop, ...rest } = d
      void _drop
      await db.order.upsert({ where: { id: d.id }, create: rest, update: rest })
    }
  })

  await importTable(summary, 'orderItems', rowsOf(data.orderItems), normalizeOrderItem, async (ids) =>
    (await db.orderItem.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((r) => r.id),
  async (d) => {
    await db.orderItem.upsert({ where: { id: d.id }, create: d, update: d })
  })

  await importTable(summary, 'payments', rowsOf(data.payments), normalizePayment, async (ids) =>
    (await db.payment.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((r) => r.id),
  async (d) => {
    await db.payment.upsert({ where: { id: d.id }, create: d, update: d })
  })

  await importTable(summary, 'attendance', rowsOf(data.attendance), normalizeAttendance, async (ids) =>
    (await db.attendance.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((r) => r.id),
  async (d) => {
    await db.attendance.upsert({ where: { id: d.id }, create: d, update: d })
  })

  await importTable(summary, 'cashEntries', rowsOf(data.cashEntries), normalizeCashDrawerEntry, async (ids) =>
    (await db.cashDrawerEntry.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((r) => r.id),
  async (d) => {
    await db.cashDrawerEntry.upsert({ where: { id: d.id }, create: d, update: d })
  })

  await importTable(summary, 'inventoryTransactions', rowsOf(data.inventoryTransactions), normalizeInventoryTransaction, async (ids) =>
    (await db.inventoryTransaction.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((r) => r.id),
  async (d) => {
    await db.inventoryTransaction.upsert({ where: { id: d.id }, create: d, update: d })
  })

  await importTable(summary, 'reservations', rowsOf(data.reservations), normalizeReservation, async (ids) =>
    (await db.reservation.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((r) => r.id),
  async (d) => {
    await db.reservation.upsert({ where: { id: d.id }, create: d, update: d })
  })

  await importTable(summary, 'auditLogs', rowsOf(data.auditLogs), normalizeAuditLog, async (ids) =>
    (await db.auditLog.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((r) => r.id),
  async (d) => {
    await db.auditLog.upsert({ where: { id: d.id }, create: d, update: d })
  })

  // ─── R21 tables (purchasing, stock, promotions) ─────────────────────

  await importTable(summary, 'suppliers', rowsOf(data.suppliers), normalizeSupplier, async (ids) =>
    (await db.supplier.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((r) => r.id),
  async (d) => {
    await db.supplier.upsert({ where: { id: d.id }, create: d, update: d })
  })

  await importTable(summary, 'purchaseOrders', rowsOf(data.purchaseOrders), normalizePurchaseOrder, async (ids) =>
    (await db.purchaseOrder.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((r) => r.id),
  async (d) => {
    await db.purchaseOrder.upsert({ where: { id: d.id }, create: d, update: d })
  })

  await importTable(summary, 'purchaseOrderItems', rowsOf(data.purchaseOrderItems), normalizePurchaseOrderItem, async (ids) =>
    (await db.purchaseOrderItem.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((r) => r.id),
  async (d) => {
    await db.purchaseOrderItem.upsert({ where: { id: d.id }, create: d, update: d })
  })

  await importTable(summary, 'stockCounts', rowsOf(data.stockCounts), normalizeStockCount, async (ids) =>
    (await db.stockCount.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((r) => r.id),
  async (d) => {
    await db.stockCount.upsert({ where: { id: d.id }, create: d, update: d })
  })

  await importTable(summary, 'stockCountLines', rowsOf(data.stockCountLines), normalizeStockCountLine, async (ids) =>
    (await db.stockCountLine.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((r) => r.id),
  async (d) => {
    await db.stockCountLine.upsert({ where: { id: d.id }, create: d, update: d })
  })

  await importTable(summary, 'wasteLogs', rowsOf(data.wasteLogs), normalizeWasteLog, async (ids) =>
    (await db.wasteLog.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((r) => r.id),
  async (d) => {
    await db.wasteLog.upsert({ where: { id: d.id }, create: d, update: d })
  })

  await importTable(summary, 'promotions', rowsOf(data.promotions), normalizePromotion, async (ids) =>
    (await db.promotion.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((r) => r.id),
  async (d) => {
    await db.promotion.upsert({ where: { id: d.id }, create: d, update: d })
  })

  return summary
}

/** One-line human summary for the audit trail. */
export function summarizeCounts(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([table, n]) => `${table} ${n}`)
  return parts.length > 0 ? parts.join(', ') : 'no rows'
}
