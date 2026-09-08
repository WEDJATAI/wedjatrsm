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
  active: boolean
  productCount?: number
}

export type Product = {
  id: number
  name: string
  /** optional Arabic display name — shown when the UI language is Arabic */
  nameAr?: string | null
  categoryId: number | null
  category?: { id: number; name: string; nameAr?: string | null } | null
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
  product?: { id: number; name: string; nameAr?: string | null } | null
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
  method: 'cash' | 'card' | 'other' | string
  amount: number
  /** R8: gratuity on top of the billed amount (not counted in paidAmount) */
  tip?: number
  reference: string | null
  createdAt: string
}

export type Order = {
  id: number
  tableId: number | null
  table?: { id: number; name: string } | null
  userId: number | null
  user?: { id: number; name: string } | null
  status: 'open' | 'paid' | 'cancelled' | 'merged' | 'deferred' | string
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
}

// ─── Backups ────────────────────────────────────────

export type BackupInfo = {
  name: string
  sizeBytes: number
  createdAt: string
}
