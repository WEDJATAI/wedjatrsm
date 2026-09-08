// ─── POS shared helpers & types (client-side) ────────────────────────

import { SERVICE_TAX_RATE, TAX_RATE } from '@/lib/constants'
import { formatCurrency } from '@/lib/format'
import type { Order, Product, SelectedModifier } from '@/lib/types'

/** A local, not-yet-sent cart line. */
export type DraftItem = {
  key: string
  productId: number
  name: string
  /** optional Arabic display name — mirrors Product.nameAr so unsent cart
   *  lines can render in the UI language like sent order lines do. */
  nameAr?: string | null
  price: number
  quantity: number
  notes: string
  course: string
  /** R8: option snapshots chosen at add time (modifiers are picked once in
   *  the sheet — the edit dialog only changes qty/notes/course). The BASE
   *  product price stays in `price`; deltas are summed on the fly. */
  modifiers?: SelectedModifier[]
}

/** Effective unit price of a draft line: base product price + Σ priceDelta. */
export function lineUnitPrice(d: DraftItem): number {
  const delta = d.modifiers?.reduce((sum, m) => sum + (m.priceDelta ?? 0), 0) ?? 0
  return round2(d.price + delta)
}

/** Round to 2 decimals — all client-side money math goes through this. */
export function round2(x: number): number {
  return Math.round((Number.isFinite(x) ? x : 0) * 100) / 100
}

export type CartTotals = {
  /** subtotal of sent order lines + draft lines */
  subtotal: number
  discount: number
  /** 14% VAT on (subtotal − discount) */
  tax: number
  /** 12% service tax on (subtotal − discount) — in addition to the VAT */
  serviceTax: number
  total: number
  draftSubtotal: number
}

export function computeDraftSubtotal(draft: DraftItem[]): number {
  return round2(draft.reduce((sum, d) => sum + d.quantity * lineUnitPrice(d), 0))
}

/** Modifier signature for draft-line merging: option ids joined in order.
 *  Two lines merge only when their signatures match exactly (both empty =
 *  plain items of the same product). */
export function modifierSignature(mods?: SelectedModifier[] | null): string {
  return (mods ?? []).map((m) => m.id).join(',')
}

/** Localized price-delta label: `+EGP 8` / `−EGP 3` / '' when zero. */
export function modifierDeltaLabel(delta: number): string {
  if (!Number.isFinite(delta) || delta === 0) return ''
  const abs = formatCurrency(Math.abs(delta))
  return delta > 0 ? `+${abs}` : `−${abs}`
}

/**
 * Combined display totals while an order is open:
 * subtotal = order.subtotalAmount + draft lines; discount is order-level.
 * total = (subtotal − discount) + VAT(14%) + service tax (12%).
 */
export function computeCartTotals(order: Order | null, draft: DraftItem[]): CartTotals {
  const draftSubtotal = computeDraftSubtotal(draft)
  const subtotal = round2((order?.subtotalAmount ?? 0) + draftSubtotal)
  const discount = Math.max(0, round2(order?.discountAmount ?? 0))
  const base = Math.max(0, round2(subtotal - discount))
  const tax = round2(base * TAX_RATE)
  const serviceTax = round2(base * SERVICE_TAX_RATE)
  const total = round2(base + tax + serviceTax)
  return { subtotal, discount, tax, serviceTax, total, draftSubtotal }
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

/** Escape a string for safe inclusion in generated print-window HTML (user names, notes…). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
