// ─── Shared API payload types (client + server) ─────────────────────

export type SessionUser = {
  id: number
  email: string
  name: string
  role: 'admin' | 'waiter' | 'kitchen' | string
}

export type Category = {
  id: number
  name: string
  displayOrder: number
  active: boolean
  productCount?: number
}

export type Product = {
  id: number
  name: string
  categoryId: number | null
  category?: { id: number; name: string } | null
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
  positionX: number
  positionY: number
  status: 'free' | 'occupied' | 'reserved' | string
  active: boolean
  // polling extras (tables/status + floorplans)
  openOrderId?: number | null
  openOrderTotal?: number | null
  openOrderItemCount?: number | null
  openOrderSince?: string | null
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
  product?: { id: number; name: string } | null
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
  status: 'open' | 'paid' | 'cancelled' | 'merged' | string
  subtotalAmount: number
  totalAmount: number
  discountAmount: number
  taxAmount: number
  paidAmount: number
  remainingAmount: number
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

// ─── Request payload types ──────────────────────────────────────────

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
