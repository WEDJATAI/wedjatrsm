// ─── Shared API payload types (client + server) ─────────────────────

export type SessionUser = {
  id: number
  email: string
  name: string
  role: 'admin' | 'waiter' | 'kitchen' | 'custom' | string
  permissions: string[]
  /** display name of the custom role (role === 'custom'), else null */
  roleName: string | null
}

export type CustomRole = {
  id: number
  name: string
  permissions: string[] // module keys
  active: boolean
  userCount?: number
  createdAt?: string
}

export type Shift = {
  id: number
  name: string
  startTime: string // "HH:MM"
  endTime: string // "HH:MM"
  active: boolean
}

export type AttendanceRecord = {
  id: number
  userId: number
  user: { id: number; name: string; role: string; roleName?: string | null } | null
  checkInAt: string
  checkOutAt: string | null
  lateMinutes: number
  workedMinutes: number | null
  shiftName: string | null
}

export type AppSettings = {
  restaurantName: string
  /** Arabic name printed on bilingual checks (falls back to the EN name) */
  restaurantNameAr?: string
}

export type Category = {
  id: number
  name: string
  /** optional Arabic display name — shown when the UI language is Arabic */
  nameAr?: string | null
  displayOrder: number
  /** R11: station routing — null/absent = default kitchen screen */
  prepDestination?: string | null
  active: boolean
  productCount?: number
}

export type Product = {
  id: number
  name: string
  /** optional Arabic display name — shown when the UI language is Arabic */
  nameAr?: string | null
  categoryId: number | null
  category?: { id: number; name: string; nameAr?: string | null; prepDestination?: string | null } | null
  price: number
  cost: number
  isStockable: boolean
  isSellable: boolean
  sku: string | null
  imageUrl: string | null
  active: boolean
  lowStockThreshold: number
  stock: number
  /** R8: parsed allergen tag keys (['gluten','dairy']…) — null when unset */
  allergens?: string[] | null
  /** R8: parsed dietary tag keys (['vegetarian']…) — null when unset */
  dietary?: string[] | null
  /** R13: manual 86/sold-out flag (POS one-tap toggle) */
  soldOut?: boolean
  /** R8: option groups offered with this product (POS list endpoints) */
  modifierGroups?: ModifierGroupDTO[]
}

export type RestaurantTable = {
  id: number
  floorPlanId: number | null
  name: string
  capacity: number
  shape: 'square' | 'round' | 'rectangle' | 'oval' | string
  positionX: number
  positionY: number
  status: 'free' | 'occupied' | 'reserved' | 'paid' | 'deferred' | 'dirty' | string
  active: boolean
  // polling extras (tables/status + floorplans)
  openOrderId?: number | null
  openOrderTotal?: number | null
  openOrderItemCount?: number | null
  openOrderSince?: string | null
  openOrderGuests?: number | null
  /** true when this table is part of a multi-table (merged) seating */
  openOrderMerged?: boolean
  /** client name when the table holds a deferred (unpaid, client left) check */
  deferredClientName?: string | null
  /** order id of the deferred check still tied to this table (cleanup pending) */
  deferredOrderId?: number | null
}

export type FloorPlan = {
  id: number
  name: string
  backgroundImage: string | null
  active: boolean
  tables: RestaurantTable[]
}

export type OrderItem = {
  id: number
  orderId: number
  productId: number | null
  product?: { id: number; name: string; nameAr?: string | null; category?: { prepDestination?: string | null } | null } | null
  quantity: number
  unitPrice: number
  notes: string | null
  course: 'starter' | 'main' | 'dessert' | 'drink' | string
  status: 'new' | 'preparing' | 'ready' | 'served' | string
  /** R8: selected options snapshot (name/priceDelta recorded at order time) */
  selectedModifiers?: SelectedModifier[] | null
  createdAt: string
}

export type Payment = {
  id: number
  orderId: number
  method: 'cash' | 'card' | 'other' | 'loyalty' | string
  amount: number
  /** R8: gratuity on top of the billed amount (not counted in paidAmount) */
  tip?: number
  reference: string | null
  createdAt: string
}

// ─── R13: customers & loyalty ─────────────────────────────────
export type Customer = {
  id: number
  name: string
  phone: string | null
  visits: number
  points: number
  totalSpent: number
  lastVisitAt: string | null
  notes: string | null
  active: boolean
  createdAt: string
  /** detail payload only — recent orders + upcoming reservations */
  orders?: Order[]
  reservations?: Reservation[]
}

export type Order = {
  id: number
  tableId: number | null
  table?: { id: number; name: string } | null
  userId: number | null
  user?: { id: number; name: string } | null
  status: 'open' | 'paid' | 'cancelled' | 'merged' | 'deferred' | string
  /** R11: 'dinein' (default) | 'takeaway' | 'delivery' */
  orderType: 'dinein' | 'takeaway' | 'delivery' | string
  /** R11: delivery contact — set when orderType = 'delivery' */
  deliveryPhone?: string | null
  deliveryAddress?: string | null
  /** R13: loyalty — attached customer + points earned/redeemed */
  customerId?: number | null
  customer?: { id: number; name: string; phone?: string | null; points?: number } | null
  pointsEarned?: number
  pointsRedeemed?: number
  /** R13: delivery-aggregator idempotency ref (provider:externalId) */
  externalRef?: string | null
  subtotalAmount: number
  totalAmount: number
  discountAmount: number
  taxAmount: number
  /** 12% service tax (in addition to the 14% VAT) */
  serviceTaxAmount: number
  /** R8: manager-approved discount justification */
  discountReason?: string | null
  /** client name for deferred checks (pay later) */
  clientName: string | null
  /** extra table ids joined to this order (merged seating from the beginning) */
  extraTableIds: number[]
  paidAmount: number
  remainingAmount: number
  guests: number
  createdAt: string
  closedAt: string | null
  items: OrderItem[]
  payments: Payment[]
}

export type RecipeComponent = {
  id: number
  productId: number
  ingredientId: number
  quantity: number
  ingredient?: Product
}

export type InventoryItem = {
  productId: number
  name: string
  sku: string | null
  stock: number
  cost: number
  value: number
  lowStockThreshold: number
  isLow: boolean
  unit?: string
}

export type InventoryTransaction = {
  id: number
  productId: number
  product?: { id: number; name: string } | null
  quantityChange: number
  reason: string | null
  orderId: number | null
  createdAt: string
}

export type SalesReport = {
  totalRevenue: number
  totalOrders: number
  avgOrderValue: number
  totalGuests: number
  avgCheckPerPerson: number
  /** total still outstanding on deferred (pay-later) checks */
  deferredOutstanding: number
  deferredCount: number
  byMethod: { method: string; amount: number; count: number }[]
  topProducts: { productId: number; name: string; quantity: number; revenue: number }[]
  byCategory: { categoryId: number | null; name: string; revenue: number; quantity: number }[]
  byDay: { date: string; revenue: number; orders: number }[]
  byHour: { hour: number; revenue: number; orders: number }[]
}

export type InventoryValueReport = {
  totalValue: number
  itemCount: number
  lowStockCount: number
}

// ─── R8: modifier groups (item options) ─────────────

/** one option row inside a group */
export type ModifierOptionDTO = {
  id: number
  name: string
  nameAr?: string | null
  priceDelta: number
  active: boolean
  sortOrder: number
}

/** a group with its options, as returned by the modifier-group APIs */
export type ModifierGroupDTO = {
  id: number
  name: string
  nameAr?: string | null
  minSelect: number
  maxSelect: number
  active: boolean
  sortOrder: number
  modifiers: ModifierOptionDTO[]
  /** attached product count (admin list endpoint) */
  productCount?: number
}

/** snapshot stored on an order item (JSON column selected_modifiers) */
export type SelectedModifier = {
  id: number
  name: string
  nameAr?: string | null
  priceDelta: number
}

// ─── R8: cash drawer sessions ───────────────────────

export type CashDrawerEntryDTO = {
  id: number
  sessionId: number
  type: 'paid_in' | 'paid_out' | string
  amount: number
  note: string | null
  userId: number | null
  user?: { id: number; name: string } | null
  createdAt: string
}

export type CashDrawerSessionDTO = {
  id: number
  user?: { id: number; name: string } | null
  openingFloat: number
  openedAt: string
  closedAt: string | null
  countedCash: number | null
  expectedCash: number | null
  variance: number | null
  note: string | null
  entries?: CashDrawerEntryDTO[]
}

export type CashDrawerStatus = {
  active: CashDrawerSessionDTO | null
  expected: {
    openingFloat: number
    cashSales: number
    cashTips: number
    paidIn: number
    paidOut: number
    total: number
  } | null
  recentSessions: CashDrawerSessionDTO[]
}

// ─── R8: server shift report (My shift) ─────────────

export type MyShiftReport = {
  userId: number
  userName: string
  /** total of orders opened by this user today (paid + open, pre-discount totals) */
  salesTotal: number
  /** totalAmount of PAID orders opened today */
  paidTotal: number
  ordersCount: number
  paidOrdersCount: number
  openChecksCount: number
  openValue: number
  tipsTotal: number
  avgCheck: number
  byMethod: { method: string; amount: number; count: number; tip: number }[]
}

// ─── R8: menu engineering (reports) ─────────────────

export type MenuItemStat = {
  productId: number
  name: string
  nameAr?: string | null
  soldQty: number
  revenue: number
  /** Σ qty × (unitPrice − product.cost) — approximate food profit */
  profit: number
  /** profit / revenue (0..1); 0 when revenue is 0 */
  margin: number
  /** share of total quantity sold (0..1) */
  popularity: number
  classification: 'star' | 'plowhorse' | 'puzzle' | 'dog'
}

export type MenuEngineeringReport = {
  periodDays: number
  totalSoldQty: number
  avgMargin: number
  avgPopularity: number
  items: MenuItemStat[]
}

// ─── Request payload types ──────────────────────────

export type NewOrderItemPayload = {
  productId: number
  quantity: number
  notes?: string
  course?: string
  /** R8: selected option snapshots (validated server-side) */
  selectedModifiers?: SelectedModifier[]
}

export type NewPaymentPayload = {
  method: string
  amount: number
  /** R8: gratuity on top of the billed amount */
  tip?: number
  reference?: string
}

// ─── Audit log ──────────────────────────────────────

export type AuditLogEntry = {
  id: number
  userId: number | null
  userName: string
  action: string
  entity: string
  entityId: number | null
  details: string | null
  createdAt: string
}

export type AuditLogPage = {
  logs: AuditLogEntry[]
  total: number
  page: number
  pageSize: number
}

// ─── Z-Report (end-of-day reconciliation) ───────────

export type ZReport = {
  date: string
  ordersClosed: number
  covers: number
  grossSubtotal: number
  discounts: number
  vat: number
  serviceTax: number
  netTotal: number
  avgCheck: number
  cancelledCount: number
  paymentsByMethod: { method: string; amount: number; count: number }[]
  paymentsTotal: number
  deferredSettled: number
  deferredOutstanding: number
  byWaiter: { userId: number | null; name: string; orders: number; net: number; tips?: number }[]
  /** R8: gratuity totals for the day */
  tips: { total: number; cash: number; card: number; other: number }
  /** R17: refunds issued this day (negative payments) — net value */
  refunds: { total: number; count: number }
}

// ─── Backups ────────────────────────────────────────

export type BackupInfo = {
  name: string
  sizeBytes: number
  createdAt: string
  /** R14: how the snapshot was created (filename prefix `custom-auto|manual-`). */
  kind?: 'auto' | 'manual'
}

/** R14: auto-backup schedule status returned by GET /api/admin/backup. */
export type AutoBackupStatus = {
  lastAt: string | null
  nextAt: string | null
  intervalHours: number
  retention: number
}

// ─── R9: AI vision / CCTV seating intelligence ──────────────────────
// Contract shared by /api/vision/** routes and the vision UI. Vision is a
// PARALLEL OBSERVATIONAL layer: it never writes operational table state
// (`tables.status`) except via the human-confirmed movement flow.

export type VisionCameraStatus = 'online' | 'offline' | 'error' | 'disabled'

export type VisionCameraDTO = {
  id: number
  code: string
  name: string
  /** masked in API responses (credentials never returned) */
  streamUrl: string | null
  floorPlanId: number | null
  floorPlanName: string | null
  status: VisionCameraStatus | string
  lastSeenAt: string | null
  lastError: string | null
  zoneCount: number
  active: boolean
  createdAt: string
}

export type VisionZoneKind = 'table' | 'entrance' | 'bar' | 'waiting' | 'other'

export type VisionZonePoint = { x: number; y: number }

export type VisionZoneDTO = {
  id: number
  cameraId: number
  cameraCode: string
  name: string
  kind: VisionZoneKind | string
  tableId: number | null
  tableName: string | null
  floorPlanId: number | null
  /** normalized 0..1 camera-frame coords */
  polygon: VisionZonePoint[]
  seats: number | null
  active: boolean
  version: number
  createdAt: string
  updatedAt: string
}

export type VisionObservationState = 'unknown' | 'empty' | 'occupied'

export type VisionTableStateDTO = {
  state: VisionObservationState | string
  peopleCount: number
  confidence: number
  stateSince: string | null
  lastEventAt: string | null
  manualHoldUntil: string | null
  /** false when the observing camera is offline/error/disabled/unknown */
  cameraOnline: boolean
}

export type VisionTableMismatch = 'none' | 'seated_no_order' | 'left_check_open'

export type VisionFloorTableDTO = RestaurantTable & {
  zoneId: number | null
  zoneName: string | null
  cameraCode: string | null
  vision: VisionTableStateDTO
  mismatch: VisionTableMismatch | string
}

export type VisionFloorDTO = {
  id: number
  name: string
  tables: VisionFloorTableDTO[]
}

export type VisionAlertKind = 'no_order' | 'left_check_open' | 'camera_offline' | 'camera_error'

export type VisionAlertDTO = {
  kind: VisionAlertKind | string
  severity: 'info' | 'warning' | 'critical' | string
  tableId: number | null
  tableName: string | null
  cameraCode: string | null
  /** stable i18n key suffix for the message body */
  messageKey: string
  since: string | null
  peopleCount: number | null
}

export type VisionConfigDTO = {
  highConfidence: number
  mediumConfidence: number
  vacancyDelaySeconds: number
  movementDedupeMinutes: number
  movementCooldownMinutes: number
  serviceDelayMinutes: number
  maxEventAgeSeconds: number
  manualHoldMinutes: number
}

export type VisionOverviewDTO = {
  kpis: {
    totalGuests: number
    occupiedTables: number
    availableTables: number
    posOccupied: number
    pendingMovements: number
    reviewRequired: number
    coveredTables: number
    occupancyPct: number
    avgDwellMinutes: number | null
    camerasOnline: number
    camerasTotal: number
  }
  cameras: VisionCameraDTO[]
  floors: VisionFloorDTO[]
  alerts: VisionAlertDTO[]
  config: VisionConfigDTO
  updatedAt: string
}

export type MovementCandidateStatus =
  | 'pending'
  | 'confirmed'
  | 'rejected'
  | 'conflict'
  | 'expired'

export type MovementEvidence = {
  cameraCode: string | null
  eventIds: string[]
  peopleCount: number
  confidence: number
} | null

export type MovementCandidateDTO = {
  id: number
  fromTableId: number
  fromTableName: string
  toTableId: number
  toTableName: string
  peopleCount: number
  confidence: number
  orderId: number | null
  orderTotal: number | null
  detectedAt: string
  status: MovementCandidateStatus | string
  evidence: MovementEvidence
  decidedByName: string | null
  decidedAt: string | null
  decisionReason: string | null
  appliedAt: string | null
  createdAt: string
  /** live re-check of operational state at serialization time */
  currentState: {
    fromTableStatus: string
    toTableStatus: string
    orderStatus: string | null
    orderTableId: number | null
  }
}

export type VisionEventOutcome =
  | 'applied'
  | 'duplicate'
  | 'stale'
  | 'out_of_order'
  | 'low_confidence'
  | 'unknown_camera'
  | 'unknown_zone'
  | 'rejected'
  | 'cooldown_suppressed'

export type VisionEventDTO = {
  id: number
  eventId: string
  type: string
  cameraCode: string
  zoneId: number | null
  tableId: number | null
  peopleCount: number | null
  confidence: number | null
  detectedAt: string
  outcome: VisionEventOutcome | string
  outcomeDetail: string | null
  model: string | null
  receivedAt: string
}

export type VisionIngestResult = {
  event_id: string
  outcome: VisionEventOutcome | string
  detail: string | null
}

export type VisionAnalyticsDTO = {
  from: string
  to: string
  totalGuestsObserved: number
  avgDwellMinutes: number | null
  avgTurnoverMinutes: number | null
  occupiedTableHours: number
  revenuePerOccupiedTableHour: number | null
  occupancyByHour: { hour: number; occupiedPct: number; avgGuests: number }[]
  movementStats: {
    total: number
    confirmed: number
    rejected: number
    pending: number
    conflict: number
    expired: number
    confirmRate: number | null
  }
  eventStats: { total: number; applied: number; duplicates: number; stale: number; lowConfidence: number }
  perTable: {
    tableId: number
    name: string
    occupiedPeriods: number
    totalDwellMinutes: number
    avgDwellMinutes: number | null
    turnoverCount: number
  }[]
  cameraUptime: { cameraCode: string; events: number; onlinePct: number; lastSeenAt: string | null }[]
}

// ─── R11: Reservations (table bookings) ─────────────────────────────
export type Reservation = {
  id: number
  customerName: string
  customerPhone: string | null
  /** R13: loyalty link (auto-matched by phone at booking) */
  customerId?: number | null
  customer?: { id: number; name: string; phone?: string | null; points?: number } | null
  partySize: number
  floorPlanId: number | null
  floorPlan?: { id: number; name: string } | null
  tableId: number | null
  table?: { id: number; name: string } | null
  reservedAt: string
  /** stored status; 'completed' is DERIVED when the linked order is closed */
  status: 'pending' | 'seated' | 'completed' | 'cancelled' | 'no_show' | string
  notes: string | null
  orderId: number | null
  order?: { id: number; status: string; totalAmount: number } | null
  createdBy: string | null
  createdAt: string
  updatedAt: string
}

// ─── R15: Offline-first Windows deployment — sync contracts ─────────
export type SyncPendingCounts = {
  orders: number
  orderItems: number
  payments: number
  customers: number
  attendance: number
  cashEntries: number
  inventoryTransactions: number
  reservations: number
  auditLogs: number
  total: number
}

export type SyncSettingsDTO = {
  targetUrl: string
  autoExport: boolean
  lastExportAt: string | null
  lastPushAt: string | null
  syncKeyMasked: string
  pending: SyncPendingCounts
}

export type SyncBundle = {
  format: 'rsm-sync/1'
  mode: 'delta' | 'full'
  since: string | null
  generatedAt: string
  source: string
  counts: Record<string, number>
  data: {
    customers: unknown[]
    orders: unknown[]
    orderItems: unknown[]
    payments: unknown[]
    attendance: unknown[]
    cashEntries: unknown[]
    inventoryTransactions: unknown[]
    reservations: unknown[]
    auditLogs: unknown[]
  }
}

export type SyncImportSummary = {
  inserted: Record<string, number>
  updated: Record<string, number>
  skipped: Record<string, number>
}

// ═══════════════════════════════════════════════════════════════════
// R17: Foodics/Odoo-level operations — shared API contracts for the
// purchasing, stock-count, waste, promotions and payroll modules.
// These types are the contract between the R17 API routes and views.
// ═══════════════════════════════════════════════════════════════════

// ─── R17: Suppliers & purchase orders (Odoo Purchasing) ────────────
export type Supplier = {
  id: number
  name: string
  phone: string | null
  email: string | null
  address: string | null
  notes: string | null
  active: boolean
  createdAt: string
  /** aggregated across received PO lines (0 for new suppliers) */
  purchaseCount: number
  totalPurchased: number
}

export type PurchaseOrderLineDTO = {
  id: number
  productId: number
  product: { id: number; name: string; nameAr: string | null; sku: string | null; cost: number }
  quantity: number
  receivedQuantity: number
  unitCost: number
  /** quantity × unitCost */
  lineTotal: number
}

export type PurchaseOrderDTO = {
  id: number
  number: string
  supplierId: number
  supplier: { id: number; name: string }
  status: 'draft' | 'ordered' | 'received' | 'cancelled' | string
  note: string | null
  expectedAt: string | null
  orderedAt: string | null
  receivedAt: string | null
  createdAt: string
  createdBy: string | null
  lines: PurchaseOrderLineDTO[]
  total: number
  receivedTotal: number
  /** sum((quantity − receivedQuantity) × unitCost) over open lines */
  outstanding: number
}

// ─── R17: Stock counts (Foodics Stock Count) ───────────────────────
export type StockCountLineDTO = {
  id: number
  productId: number
  product: { id: number; name: string; nameAr: string | null; sku: string | null; cost: number }
  systemQty: number
  countedQty: number | null
  /** countedQty − systemQty (null while uncounted) */
  variance: number | null
  /** variance × product cost (null while uncounted) */
  valueImpact: number | null
}

export type StockCountDTO = {
  id: number
  number: string
  status: 'open' | 'posted' | 'cancelled' | string
  note: string | null
  createdAt: string
  postedAt: string | null
  createdBy: string | null
  lines: StockCountLineDTO[]
  /** sum of |valueImpact| for counted lines (shrinkage + overage magnitude) */
  totalValueImpact: number
}

// ─── R17: Waste log (Foodics Waste) ────────────────────────────────
export type WasteLogDTO = {
  id: number
  productId: number
  product: { id: number; name: string; nameAr: string | null }
  quantity: number
  costValue: number
  reason: string
  note: string | null
  user: { id: number; name: string } | null
  createdAt: string
}

export type WasteReport = {
  from: string
  to: string
  totalValue: number
  entries: number
  byReason: { reason: string; quantity: number; value: number; entries: number }[]
  topItems: { productId: number; name: string; quantity: number; value: number }[]
}

// ─── R17: Promotions engine (Foodics) ──────────────────────────────
export type PromotionDTO = {
  id: number
  name: string
  nameAr: string | null
  type: 'percent' | 'fixed' | string
  value: number
  scope: 'order' | 'category' | 'product' | string
  categoryId: number | null
  category: { id: number; name: string } | null
  productId: number | null
  product: { id: number; name: string } | null
  /** parsed from the stored CSV (empty array = every day) */
  daysOfWeek: number[]
  startTime: string | null
  endTime: string | null
  startDate: string | null
  endDate: string | null
  active: boolean
  createdAt: string
}

/** runtime evaluation of one cart against active promotions (shared by the
 *  POS cart preview and the order-submit revalidation — server-authoritative) */
export type PromoEvaluation = {
  promotion: { id: number; name: string; nameAr: string | null; type: string; value: number }
  /** EGP discount this promotion gives the cart */
  discount: number
  /** matched scope label ('Drinks', product name, null for whole order) */
  scopeLabel: string | null
}

// ─── R17: Payroll (Odoo HR lite) ───────────────────────────────────
export type PayrollLine = {
  userId: number
  name: string
  role: string
  hourlyRate: number
  sessions: number
  /** worked hours in the window, 2dp */
  hours: number
  grossPay: number
  lateMinutes: number
}

export type PayrollReport = {
  from: string
  to: string
  lines: PayrollLine[]
  totalHours: number
  totalGrossPay: number
}

// ─── R17: Sales forecast (restored properly) ───────────────────────
export type ForecastDay = {
  date: string // YYYY-MM-DD
  dayLabel: string // e.g. 'Sat'
  actual: number | null // gross sales that day (null = future)
  projected: number | null // projected sales (null = past)
}

export type ForecastReport = {
  /** first history day (28 days back) */
  from: string
  /** last projected day (7 days ahead) */
  to: string
  history: ForecastDay[]
  projection: ForecastDay[]
  /** average daily sales over the history window */
  avgDaily: number
  /** projected weekly total */
  projectedWeekTotal: number
}
