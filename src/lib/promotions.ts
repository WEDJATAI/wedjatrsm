// ─── R17: Promotions engine — shared evaluation library ──────────────
// Pure functions only: NO database imports, no Next/server APIs. Safe to
// import from BOTH client components (POS cart preview) and server route
// handlers / lib/orders.ts (authoritative application). All money results
// are rounded to 2 decimals; a promo can never push a cart negative.
//
// Discount-source rule (one discount per order, manager wins):
//   - if the order carries a MANAGER discount (discountReason non-empty,
//     not starting with 'PROMO', amount > 0) → promotions are skipped;
//   - otherwise the BEST live promotion discount is applied live at every
//     totals recompute, and stored as
//       discountReason = `PROMO #<id> — <name>`   (audit marker convention)
//     never stacked with anything else.

import type { PromotionDTO, PromoEvaluation } from '@/lib/types'

/** One cart line for evaluation — price is the effective unit price
 *  (product price + modifier deltas) exactly as stored on the order item. */
export type CartLine = {
  productId: number
  categoryId: number | null
  unitPrice: number
  quantity: number
}

/** Window/schedule subset of a promotion (accepts PromotionDTO too). */
export type PromotionSchedule = {
  daysOfWeek: number[]
  startTime: string | null
  endTime: string | null
  startDate: string | null
  endDate: string | null
}

/** Round to 2 decimals — every money result crosses this boundary. */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/** "HH:MM" (24h) → minutes past local midnight; null when malformed. */
function hhmmToMinutes(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** Local minutes-of-day of `now` (e.g. 18:32 → 1112). */
function localMinutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes()
}

/** Local calendar date as "YYYY-MM-DD" (lexicographically comparable). */
function localDateKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Normalize any stored date (Date | full ISO | "YYYY-MM-DD") to the local
 *  "YYYY-MM-DD" calendar day it represents — timezone-shift-proof. */
export function toDateKey(value: Date | string | null | undefined): string | null {
  if (value == null) return null
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return localDateKey(d)
}

/**
 * Whether a promotion is live at `now`:
 *  - day: now.getDay() ∈ daysOfWeek (empty array = every day);
 *  - time window (local HH:MM, inclusive on both ends): null/null = all
 *    day; only startTime → until end of day; only endTime → from midnight;
 *    endTime < startTime wraps past midnight (e.g. 22:00–02:00);
 *  - date range: inclusive on both days (endDate runs through the END of
 *    that local calendar day), null = unbounded.
 */
export function isPromotionLive(p: PromotionSchedule, now: Date): boolean {
  // day of week (JS getDay digits 0=Sun … 6=Sat; empty = every day)
  if (p.daysOfWeek.length > 0 && !p.daysOfWeek.includes(now.getDay())) return false

  // time window (local minutes, inclusive bounds)
  const start = p.startTime != null ? hhmmToMinutes(p.startTime) : null
  const end = p.endTime != null ? hhmmToMinutes(p.endTime) : null
  if (start != null || end != null) {
    const m = localMinutesOfDay(now)
    const from = start ?? 0 // only endTime → from midnight
    const to = end ?? 24 * 60 // only startTime → to end of day
    if (to < from) {
      // wraps past midnight: live from `from` to 24:00 AND 00:00 to `to`
      if (m < from && m > to) return false
    } else if (m < from || m > to) {
      return false
    }
  }

  // date range (inclusive; compare local "YYYY-MM-DD" keys lexicographically).
  // Values arriving as full ISO strings are normalized to their local day
  // first so UTC shifts can never move the boundary by a day.
  const today = localDateKey(now)
  const startDate = toDateKey(p.startDate)
  const endDate = toDateKey(p.endDate)
  if (startDate != null && today < startDate) return false
  if (endDate != null && today > endDate) return false
  return true
}

/** Sum of line amounts matching the promotion's scope (order = everything). */
function matchedSubtotal(p: PromotionDTO, lines: CartLine[]): { subtotal: number; scopeLabel: string | null } | null {
  if (p.scope === 'category') {
    if (p.categoryId == null) return null
    const subtotal = lines
      .filter((l) => l.categoryId === p.categoryId)
      .reduce((sum, l) => sum + l.unitPrice * l.quantity, 0)
    if (subtotal <= 0) return null
    return { subtotal, scopeLabel: p.category?.name ?? null }
  }
  if (p.scope === 'product') {
    if (p.productId == null) return null
    const subtotal = lines
      .filter((l) => l.productId === p.productId)
      .reduce((sum, l) => sum + l.unitPrice * l.quantity, 0)
    if (subtotal <= 0) return null
    return { subtotal, scopeLabel: p.product?.name ?? null }
  }
  // whole order
  const subtotal = lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0)
  if (subtotal <= 0) return null
  return { subtotal, scopeLabel: null }
}

/**
 * Evaluate ONE promotion against a cart at `now`.
 * Returns null when the promotion is not live, matches no items, or yields
 * no discount; otherwise the 2dp discount and the matched scope label.
 *   - percent: matched × value / 100
 *   - fixed:   min(value, matched)  (never exceeds the matched scope)
 */
export function evaluatePromotion(
  p: PromotionDTO,
  lines: CartLine[],
  now: Date,
): { discount: number; scopeLabel: string | null } | null {
  if (!p.active) return null
  if (lines.length === 0) return null
  if (!isPromotionLive(p, now)) return null
  const matched = matchedSubtotal(p, lines)
  if (matched == null) return null
  let discount: number
  if (p.type === 'percent') {
    discount = (matched.subtotal * p.value) / 100
  } else {
    discount = Math.min(p.value, matched.subtotal)
  }
  discount = round2(discount)
  if (!(discount > 0)) return null
  return { discount, scopeLabel: matched.scopeLabel }
}

/**
 * Best promotion for a cart: largest discount wins, ties → lowest promo id.
 * The returned discount is clamped to the FULL cart subtotal here (defensive
 * — evaluatePromotion already caps percent at its matched scope and fixed at
 * min(value, matched), so with API-validated values (percent ≤ 100) this
 * clamp can never bite; it exists so the library can never produce a
 * negative cart even on malformed data). Inactive rows are skipped.
 */
export function bestPromotion(
  promos: PromotionDTO[],
  lines: CartLine[],
  now: Date,
): PromoEvaluation | null {
  const cartSubtotal = round2(
    lines.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0),
  )
  if (cartSubtotal <= 0) return null

  let best: PromoEvaluation | null = null
  for (const p of promos) {
    const result = evaluatePromotion(p, lines, now)
    if (result == null) continue
    const discount = round2(Math.min(result.discount, cartSubtotal))
    if (discount <= 0) continue
    if (
      best == null ||
      discount > best.discount ||
      (discount === best.discount && p.id < best.promotion.id)
    ) {
      best = {
        promotion: { id: p.id, name: p.name, nameAr: p.nameAr, type: p.type, value: p.value },
        discount,
        scopeLabel: result.scopeLabel,
      }
    }
  }
  return best
}

// ─── Serialization (DB row → DTO) ────────────────────────────────────

/** Structural row shape — matches the Prisma Promotion row including the
 *  category/product name relations (structural typing keeps this module
 *  free of @prisma/client imports so client bundles can use it too). */
export type PromotionRow = {
  id: number
  name: string
  nameAr: string | null
  type: string
  value: number
  scope: string
  categoryId: number | null
  category?: { id: number; name: string } | null
  productId: number | null
  product?: { id: number; name: string } | null
  /** stored CSV of JS getDay() digits ("0,1,2,3,4,5,6") */
  daysOfWeek: string
  startTime: string | null
  endTime: string | null
  startDate: Date | string | null
  endDate: Date | string | null
  active: boolean
  createdAt: Date | string
}

/** Parse the stored daysOfWeek CSV into sorted unique day digits ([] = every day). */
export function parseDaysOfWeek(csv: string): number[] {
  const days = csv
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
  return [...new Set(days)].sort((a, b) => a - b)
}

/** DB row (with category/product includes) → API PromotionDTO.
 *  daysOfWeek CSV → number[]; dates → local "YYYY-MM-DD" keys. */
export function toPromotionDTO(row: PromotionRow): PromotionDTO {
  return {
    id: row.id,
    name: row.name,
    nameAr: row.nameAr,
    type: row.type,
    value: round2(row.value),
    scope: row.scope,
    categoryId: row.categoryId,
    category: row.category ? { id: row.category.id, name: row.category.name } : null,
    productId: row.productId,
    product: row.product ? { id: row.product.id, name: row.product.name } : null,
    daysOfWeek: parseDaysOfWeek(row.daysOfWeek),
    startTime: row.startTime,
    endTime: row.endTime,
    startDate: toDateKey(row.startDate),
    endDate: toDateKey(row.endDate),
    active: row.active,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  }
}

/** The stored discountReason marker for an applied promotion (audit trail:
 *  reasons starting with this prefix are engine-generated, never manager
 *  reasons — lib/orders.ts uses it to decide "manager wins" precedence). */
export const PROMO_REASON_PREFIX = 'PROMO'

/** Build the stored discountReason for an applied promotion. */
export function promoReason(id: number, name: string): string {
  return `PROMO #${id} — ${name}`
}

/** Whether a stored discountReason is an engine-generated promo marker. */
export function isPromoReason(reason: string | null | undefined): boolean {
  return (reason ?? '').startsWith(PROMO_REASON_PREFIX)
}
