// ─── POS shared helpers & types (client-side) ────────────────────────

import { TAX_RATE } from '@/lib/constants'
import type { Order, Product } from '@/lib/types'

/** A local, not-yet-sent cart line. */
export type DraftItem = {
  key: string
  productId: number
  name: string
  price: number
  quantity: number
  notes: string
  course: string
}

/** Round to 2 decimals — all client-side money math goes through this. */
export function round2(x: number): number {
  return Math.round((Number.isFinite(x) ? x : 0) * 100) / 100
}

export type CartTotals = {
  /** subtotal of sent order lines + draft lines */
  subtotal: number
  discount: number
  tax: number
  total: number
  draftSubtotal: number
}

export function computeDraftSubtotal(draft: DraftItem[]): number {
  return round2(draft.reduce((sum, d) => sum + d.quantity * d.price, 0))
}

/**
 * Combined display totals while an order is open:
 * subtotal = order.subtotalAmount + draft lines; discount is order-level.
 */
export function computeCartTotals(order: Order | null, draft: DraftItem[]): CartTotals {
  const draftSubtotal = computeDraftSubtotal(draft)
  const subtotal = round2((order?.subtotalAmount ?? 0) + draftSubtotal)
  const discount = Math.max(0, round2(order?.discountAmount ?? 0))
  const base = Math.max(0, round2(subtotal - discount))
  const tax = round2(base * TAX_RATE)
  const total = round2(base + tax)
  return { subtotal, discount, tax, total, draftSubtotal }
}

/** Unique key for a new draft line. */
export function newDraftKey(): string {
  return `d-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

export type CourseKey = 'starter' | 'main' | 'dessert' | 'drink'

const STARTER_RE = /salad|soup|appet|mezze|starter|dip|hummus|baba|samb|bread|falafel|vine leaf/i
const DESSERT_RE = /dessert|sweet|ice ?cream|cake|pudding|basbousa|baklava|kunafa|konafa|om ali|mahalabi|umm ali/i
const DRINK_RE = /drink|beverage|juice|coffee|tea|soda|lemonade|lemon|smooth|water|hibiscus|karkad|mango|cinnamon|sahlab/i

/** Heuristic course guess (from category/product names) — used for defaults & decorative icons. */
export function guessCourse(product: Product): CourseKey {
  const hay = `${product.category?.name ?? ''} ${product.name}`
  if (DRINK_RE.test(hay)) return 'drink'
  if (DESSERT_RE.test(hay)) return 'dessert'
  if (STARTER_RE.test(hay)) return 'starter'
  return 'main'
}

/** Parse a numeric input string into a safe 2dp number. */
export function parseAmount(s: string): number {
  const v = parseFloat(s)
  if (!Number.isFinite(v) || v <= 0) return 0
  return round2(v)
}
