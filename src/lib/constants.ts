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
  'audit',
  'cashdrawer',
  'vision',
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
  audit: 'Activity Log',
  cashdrawer: 'Cash Drawer',
  vision: 'AI Vision — CCTV Occupancy',
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

export const TABLE_STATUSES = ['free', 'occupied', 'reserved', 'paid', 'deferred', 'dirty'] as const
export type TableStatus = (typeof TABLE_STATUSES)[number]
export const TABLE_STATUS_LABELS: Record<string, string> = {
  free: 'Free',
  occupied: 'Occupied',
  reserved: 'Reserved',
  paid: 'Paid — awaiting bussing',
  deferred: 'Deferred check — client left',
  dirty: 'Needs cleaning',
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

// ─── R8: item options (modifiers) ───────────────────────────────
export const MAX_OPTIONS_PER_GROUP = 20

// ─── R8: allergen + dietary tags on products ───────────────────
export const ALLERGENS = [
  'gluten',
  'dairy',
  'eggs',
  'fish',
  'shellfish',
  'nuts',
  'soy',
  'sesame',
] as const
export type Allergen = (typeof ALLERGENS)[number]

export const DIETARY_TAGS = ['vegetarian', 'vegan', 'halal', 'spicy'] as const
export type DietaryTag = (typeof DIETARY_TAGS)[number]

// ─── R8: tips on payments ──────────────────────────────────────
/** quick-tip percentage presets shown in the payment modal (0 = no tip) */
export const TIP_PRESETS = [0, 10, 12.5, 15] as const

// ─── R8: cash drawer ───────────────────────────────────────────
export const DRAWER_TYPES = ['paid_in', 'paid_out'] as const
export type DrawerEntryType = (typeof DRAWER_TYPES)[number]

// Guests bounds for an order (number of people)
export const MIN_GUESTS = 1
export const MAX_GUESTS = 30

// ─── Idle session timeout (shared POS/KDS terminals) ────────────────
// After IDLE_WARN_AFTER_MS without input a warning dialog appears with
// IDLE_LOGOUT_SECONDS to confirm; otherwise the session is ended.
export const IDLE_WARN_AFTER_MS = 15 * 60 * 1000 // 15 minutes
export const IDLE_LOGOUT_SECONDS = 60 // 1 minute countdown
// Debug/E2E only (?idleTest=1 on the URL): 10s idle → 10s countdown.
export const IDLE_TEST_WARN_MS = 10 * 1000
export const IDLE_TEST_LOGOUT_SECONDS = 10

// ─── R9: AI vision / CCTV seating intelligence ────────────────
/** every AI-derived operational change is HUMAN-confirmed — no exceptions */
export const VISION_EVENT_TYPES = ['OCCUPANCY_CHANGED', 'CAMERA_STATUS', 'MOVEMENT_DETECTED'] as const
export type VisionEventType = (typeof VISION_EVENT_TYPES)[number]

export const VISION_ZONE_KINDS = ['table', 'entrance', 'bar', 'waiting', 'other'] as const
export type VisionZoneKindValue = (typeof VISION_ZONE_KINDS)[number]

export const VISION_CAMERA_STATUSES = ['online', 'offline', 'error', 'disabled'] as const
export type VisionCameraStatusValue = (typeof VISION_CAMERA_STATUSES)[number]

export const VISION_OBSERVATION_STATES = ['unknown', 'empty', 'occupied'] as const
export type VisionObservationStateValue = (typeof VISION_OBSERVATION_STATES)[number]

export const MOVEMENT_CANDIDATE_STATUSES = ['pending', 'confirmed', 'rejected', 'conflict', 'expired'] as const
export type MovementCandidateStatusValue = (typeof MOVEMENT_CANDIDATE_STATUSES)[number]

/** AppSetting keys (existing settings mechanism is reused) */
export const VISION_CONFIG_KEY = 'visionConfig' // JSON thresholds/timings
export const VISION_INGEST_KEY = 'visionIngestKey' // edge authentication key

/** default detection thresholds & timings (admin-tunable via /api/vision/config) */
export const VISION_DEFAULT_CONFIG = {
  highConfidence: 0.85, // ≥ → observational state auto-applies
  mediumConfidence: 0.5, // ≥ → applies but flagged for review; below → recorded only
  vacancyDelaySeconds: 45, // sustained absence before occupied → empty
  movementDedupeMinutes: 10, // same from→to party merges into one pending candidate
  movementCooldownMinutes: 15, // suppressed re-creation after a rejection
  serviceDelayMinutes: 10, // seated-but-no-order alert threshold
  maxEventAgeSeconds: 600, // older events are stale — never replayed blindly
  manualHoldMinutes: 10, // human override freezes AI display state
} as const

/** ingest endpoint limits (best-effort edge protection) */
export const VISION_INGEST_MAX_EVENTS = 100 // max events per batch POST
export const VISION_INGEST_RATE_LIMIT = 120 // requests per minute per key/IP
export const VISION_STREAM_URL_RE = /^(rtsp|rtsps|http|https|onvif):\/\/[^@\s]+$/i
