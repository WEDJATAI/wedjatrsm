// ─── Shared RMS constants ───────────────────────────────────────────

export const TAX_RATE = Number(process.env.TAX_RATE ?? 0.14) // 14% VAT (Egypt)
export const SERVICE_TAX_RATE = Number(process.env.SERVICE_TAX_RATE ?? 0.12) // 12% service tax (Egypt)

// ─── Roles ──────────────────────────────────────────────────────────
// 'custom' users get their module permissions from a CustomRole record (roleId).
export const ROLES = ['admin', 'waiter', 'kitchen', 'custom'] as const
export type Role = (typeof ROLES)[number]

export const ROLE_LABELS: Record<string, string> = {
  admin: 'Admin',
  waiter: 'Waiter',
  kitchen: 'Kitchen',
  custom: 'Custom',
}

/** permission keys = UI modules; custom roles tick these in the Roles editor */
export const PERMISSIONS = [
  'pos',
  'kitchen',
  'dashboard',
  'products',
  'categories',
  'floorplans',
  'inventory',
  'recipes',
  'reports',
  'users',
  'roles',
  'attendance',
  'settings',
] as const
export type Permission = (typeof PERMISSIONS)[number]
export type PermissionList = readonly string[]

export const PERMISSION_LABELS: Record<string, string> = {
  pos: 'POS & Orders',
  kitchen: 'Kitchen Display',
  dashboard: 'Dashboard',
  products: 'Products',
  categories: 'Categories',
  floorplans: 'Floor Plans & Tables',
  inventory: 'Inventory',
  recipes: 'Recipes',
  reports: 'Reports',
  users: 'Users',
  roles: 'Roles',
  attendance: 'Attendance',
  settings: 'Settings',
}

/** built-in module grants per classic role (custom users read theirs from CustomRole) */
export const BUILTIN_ROLE_PERMISSIONS: Record<string, string[]> = {
  admin: [...PERMISSIONS],
  waiter: ['pos'],
  kitchen: ['kitchen'],
  custom: [], // resolved from CustomRole record
}

// ─── Payments / courses / statuses ─────────────────────────────────
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

export const TABLE_STATUSES = ['free', 'occupied', 'reserved', 'paid', 'deferred'] as const
export type TableStatus = (typeof TABLE_STATUSES)[number]
export const TABLE_STATUS_LABELS: Record<string, string> = {
  free: 'Free',
  occupied: 'Occupied',
  reserved: 'Reserved',
  paid: 'Paid — awaiting cleanup',
  deferred: 'Deferred check — client left',
}

export const TABLE_SHAPES = ['square', 'round', 'rectangle', 'oval'] as const
export type TableShape = (typeof TABLE_SHAPES)[number]
export const TABLE_SHAPE_LABELS: Record<string, string> = {
  square: 'Square',
  round: 'Round',
  rectangle: 'Rectangle',
  oval: 'Oval',
}

export const ORDER_STATUSES = ['open', 'paid', 'cancelled', 'merged', 'deferred'] as const
export const ORDER_STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  paid: 'Paid',
  cancelled: 'Cancelled',
  merged: 'Merged',
  deferred: 'Deferred',
}
export const INVENTORY_REASONS = ['purchase', 'adjustment', 'waste', 'sale'] as const
export const INVENTORY_REASON_LABELS: Record<string, string> = {
  purchase: 'Purchase (stock in)',
  adjustment: 'Adjustment',
  waste: 'Waste',
  sale: 'Sale',
}

// Restaurant identity (fallback — the live name is editable in Settings: AppSetting.restaurantName)
export const RESTAURANT_NAME = 'Lilo Cafe and Restaurant'
export const RESTAURANT_NAME_AR = 'ليلو كافيه ومطعم' // Arabic name printed on bilingual checks

// Merged seating (party spanning multiple tables) bounds
export const MAX_SEATING_TABLES = 4

// Item-deletion PIN (admin-set AppSetting 'deleteItemPin')
export const DELETE_PIN_KEY = 'deleteItemPin'
export const DELETE_PIN_LENGTH = 6

// Employee check-in
export const PIN_LENGTH = 6 // check-in PINs are 6 digits
export const LATE_GRACE_MINUTES = 15 // minutes of grace before a check-in counts as late

// Rounding tolerance for money comparisons
export const MONEY_EPSILON = 0.02

// Guests bounds for an order (number of people)
export const MIN_GUESTS = 1
export const MAX_GUESTS = 30
