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
}

export type RestaurantTable = {
  id: number
  floorPlanId: number | null
  name: string
  capacity: number
  shape: 'square' | 'round' | 'rectangle' | 'oval' | string
  positionX: number
  positionY: number
  status: 'free' | 'occupied' | 'reserved' | 'paid' | 'deferred' | string
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
  createdAt: string
}

export type Payment = {
  id: number
  orderId: number
  method: 'cash' | 'card' | 'other' | string
  amount: number
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

// ─── Request payload types ──────────────────────────

export type NewOrderItemPayload = {
  productId: number
  quantity: number
  notes?: string
  course?: string
}

export type NewPaymentPayload = {
  method: string
  amount: number
  reference?: string
}
