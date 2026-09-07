// ─── Shared RMS constants ───────────────────────────────────────────

export const TAX_RATE = Number(process.env.TAX_RATE ?? 0.14) // 14% VAT (Egypt)

export const ROLES = ['admin', 'waiter', 'kitchen'] as const
export type Role = (typeof ROLES)[number]

export const ROLE_LABELS: Record<string, string> = {
  admin: 'Admin',
  waiter: 'Waiter',
  kitchen: 'Kitchen',
}

export const PAYMENT_METHODS = ['cash', 'card', 'other'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]
export const PAYMENT_METHOD_LABELS: Record<string, string> = {
  cash: 'Cash',
  card: 'Card',
  other: 'Other',
}

export const COURSES = ['starter', 'main', 'dessert', 'drink'] as const
export type Course = (typeof COURSES)[number]
export const COURSE_LABELS: Record<string, string> = {
  starter: 'Starter',
  main: 'Main',
  dessert: 'Dessert',
  drink: 'Drink',
}

export const ITEM_STATUSES = ['new', 'preparing', 'ready', 'served'] as const
export type ItemStatus = (typeof ITEM_STATUSES)[number]
export const ITEM_STATUS_LABELS: Record<string, string> = {
  new: 'New',
  preparing: 'Preparing',
  ready: 'Ready',
  served: 'Served',
}

export const TABLE_STATUSES = ['free', 'occupied', 'reserved'] as const
export type TableStatus = (typeof TABLE_STATUSES)[number]
export const TABLE_STATUS_LABELS: Record<string, string> = {
  free: 'Free',
  occupied: 'Occupied',
  reserved: 'Reserved',
}

export const ORDER_STATUSES = ['open', 'paid', 'cancelled', 'merged'] as const
export const ORDER_STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  paid: 'Paid',
  cancelled: 'Cancelled',
  merged: 'Merged',
}
export const INVENTORY_REASONS = ['purchase', 'adjustment', 'waste', 'sale'] as const
export const INVENTORY_REASON_LABELS: Record<string, string> = {
  purchase: 'Purchase (stock in)',
  adjustment: 'Adjustment',
  waste: 'Waste',
  sale: 'Sale',
}

// Restaurant identity
export const RESTAURANT_NAME = 'Saffron Table'

// Rounding tolerance for money comparisons
export const MONEY_EPSILON = 0.02
