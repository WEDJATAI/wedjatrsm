/**
 * R15 sync engine — offline-first one-way merge for Windows deployments.
 *
 * Model: a Windows instance runs the FULL platform 100% locally (SQLite at
 * db/custom.db). Whenever it is online, it can EXPORT its operational
 * updates (orders, payments, customers, attendance, cash entries, inventory
 * movements, reservations, audit rows) as a `rsm-sync/1` bundle and PUSH
 * them to a hosted master instance, which merges them via /api/sync/import.
 *
 * Honest semantics (documented, by design):
 *  - This is a ONE-WAY merge: the sender's rows always win (last-writer-wins
 *    by bundle generation time), nothing is ever deleted, and rows whose FK
 *    parents are missing on the receiving side are skipped — never fatal.
 *  - `lastExportAt` marks the delta watermark. Delta bundles carry every row
 *    created after it PLUS all currently-open orders (with their items and
 *    payments) so the receiving side always sees live check state.
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

/** Rows per table created after the export watermark (all rows when unset). */
export async function computePendingCounts(lastExportAt: Date | null): Promise<SyncPendingCounts> {
  const where = lastExportAt ? { createdAt: { gt: lastExportAt } } : undefined
  const [orders, orderItems, payments, customers, attendance, cashEntries, inventoryTransactions, reservations, auditLogs] =
    await Promise.all([
      db.order.count({ where }),
      db.orderItem.count({ where }),
      db.payment.count({ where }),
      db.customer.count({ where }),
      db.attendance.count({ where }),
      db.cashDrawerEntry.count({ where }),
      db.inventoryTransaction.count({ where }),
      db.reservation.count({ where }),
      db.auditLog.count({ where }),
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
}): Promise<void> {
  if (input.targetUrl !== undefined) await upsertSetting(SYNC_KEY_TARGET_URL, input.targetUrl)
  if (input.autoExport !== undefined) await upsertSetting(SYNC_KEY_AUTO_EXPORT, String(input.autoExport))
  if (input.rotateKey) await upsertSetting(SYNC_KEY, randomBytes(24).toString('hex'))
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
 * Build a sync bundle of the 9 operational tables.
 *  - delta: rows created after the lastExportAt watermark (all rows when
 *    unset) PLUS every open order "in full" — i.e. also the open orders'
 *    items and payments — so the receiving side always gets live check
 *    state, not just rows newer than the watermark.
 *  - full: every row of the 9 tables.
 */
export async function buildSyncBundle(mode: 'delta' | 'full'): Promise<BuiltBundle> {
  const exportedAt = new Date()
  const since = mode === 'delta' ? (await readSyncState()).lastExportAt : null

  // Delta for orders/items/payments is "new rows OR anything belonging to a
  // currently-open order" (live state); the other tables are plain deltas.
  const deltaWhere = since ? { createdAt: { gt: since } } : undefined
  const orderDeltaWhere = since ? { OR: [{ createdAt: { gt: since } }, { status: 'open' as const }] } : undefined
  const itemDeltaWhere = since
    ? { OR: [{ createdAt: { gt: since } }, { order: { status: 'open' as const } }] }
    : undefined

  const [customers, orders, orderItems, payments, attendance, cashEntries, inventoryTransactions, reservations, auditLogs] =
    await Promise.all([
      db.customer.findMany({ where: deltaWhere }),
      db.order.findMany({ where: orderDeltaWhere }),
      db.orderItem.findMany({ where: itemDeltaWhere }),
      db.payment.findMany({ where: itemDeltaWhere }),
      db.attendance.findMany({ where: deltaWhere }),
      db.cashDrawerEntry.findMany({ where: deltaWhere }),
      db.inventoryTransaction.findMany({ where: deltaWhere }),
      db.reservation.findMany({ where: deltaWhere }),
      db.auditLog.findMany({ where: deltaWhere }),
    ])

  // Prisma returns rows in arbitrary order for bulk finds — sort by id for
  // deterministic, diffable bundles (self-import stays idempotent either way).
  const byId = (a: { id: number }, b: { id: number }) => a.id - b.id
  customers.sort(byId)
  orders.sort(byId)
  orderItems.sort(byId)
  payments.sort(byId)
  attendance.sort(byId)
  cashEntries.sort(byId)
  inventoryTransactions.sort(byId)
  reservations.sort(byId)
  auditLogs.sort(byId)

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
    createdAt: toDate(row.createdAt) ?? new Date(),
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
 * customers → orders → orderItems → payments → attendance → cashEntries →
 * inventoryTransactions → reservations → auditLogs.
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

  await importTable(summary, 'orders', rowsOf(data.orders), normalizeOrder, async (ids) =>
    (await db.order.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((r) => r.id),
  async (d) => {
    await db.order.upsert({ where: { id: d.id }, create: d, update: d })
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

  return summary
}

/** One-line human summary for the audit trail. */
export function summarizeCounts(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([table, n]) => `${table} ${n}`)
  return parts.length > 0 ? parts.join(', ') : 'no rows'
}
