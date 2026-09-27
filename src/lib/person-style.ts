// ─── R29: person styling + customer tier engine (shared) ─────────────
// Extracted from the R25 Launcher Home so every surface (launcher,
// customers CRM, profiles) shares ONE warm identity system:
//   · deterministic avatar color per name (same person = same color)
//   · initials for zero-photo avatars (Dr Ihab → DI)
// The tier engine grades customers by lifetime spend — the number the
// restaurant can measure, not one someone types in. Tiers are computed,
// never stored, so they upgrade themselves the moment a check closes.

// ── warm avatar palette (Team Wall / Launcher identity — no blue) ────
export const AVATAR_PALETTE = [
  'bg-amber-600',
  'bg-orange-600',
  'bg-rose-600',
  'bg-emerald-600',
  'bg-teal-600',
  'bg-fuchsia-600',
  'bg-red-600',
  'bg-lime-700',
] as const

/** Deterministic avatar background for a person's name. */
export function avatarColor(name: string): string {
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) | 0
  }
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length]
}

/** "Dr Ihab" → "DI", "Mona" → "M" (max 2 chars, uppercase). */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/)
  const first = parts[0]?.charAt(0) ?? '?'
  const second = parts.length > 1 ? (parts[parts.length - 1]?.charAt(0) ?? '') : ''
  return (first + second).toUpperCase()
}

// ── customer tiers (EGP lifetime spend; computed everywhere) ─────────
export type TierKey = 'bronze' | 'silver' | 'gold' | 'diamond'

export type TierDef = {
  key: TierKey
  /** minimum lifetime spend (EGP) to hold this tier */
  min: number
  /** i18n key suffix — customers.tier.{key} */
  labelKey: string
  /** chip classes (border/bg/text) — warm, house-palette */
  chip: string
  /** avatar ring color (border-*) for the tier badge ring */
  ring: string
  /** progress-bar tint while climbing toward the NEXT tier */
  bar: string
}

/** Ordered low → high; a customer holds the last tier whose min ≤ spend. */
export const CUSTOMER_TIERS: TierDef[] = [
  {
    key: 'bronze',
    min: 0,
    labelKey: 'customers.tier.bronze',
    chip: 'border-orange-200 bg-orange-50 text-orange-800',
    ring: 'border-orange-300',
    bar: 'bg-orange-400',
  },
  {
    key: 'silver',
    min: 2500,
    labelKey: 'customers.tier.silver',
    chip: 'border-zinc-300 bg-zinc-100 text-zinc-700',
    ring: 'border-zinc-400',
    bar: 'bg-zinc-400',
  },
  {
    key: 'gold',
    min: 7500,
    labelKey: 'customers.tier.gold',
    chip: 'border-amber-300 bg-amber-50 text-amber-800',
    ring: 'border-amber-400',
    bar: 'bg-amber-400',
  },
  {
    key: 'diamond',
    min: 15000,
    labelKey: 'customers.tier.diamond',
    chip: 'border-emerald-300 bg-emerald-50 text-emerald-800',
    ring: 'border-emerald-400',
    bar: 'bg-emerald-500',
  },
]

/** The tier a customer holds at their lifetime spend. */
export function tierOf(totalSpent: number): TierDef {
  let held = CUSTOMER_TIERS[0]
  for (const tier of CUSTOMER_TIERS) {
    if (totalSpent >= tier.min) held = tier
  }
  return held
}

/** Is this tier Gold or Diamond (the "VIP" line)? */
export function isVipTier(tier: TierDef): boolean {
  return tier.key === 'gold' || tier.key === 'diamond'
}

/**
 * Progress toward the next tier: { next, pct, remaining }.
 * pct is 0–100 (100 = at the top). remaining = EGP still to spend.
 */
export function nextTierProgress(totalSpent: number): {
  next: TierDef | null
  pct: number
  remaining: number
} {
  const held = tierOf(totalSpent)
  const idx = CUSTOMER_TIERS.indexOf(held)
  const next = CUSTOMER_TIERS[idx + 1] ?? null
  if (!next) return { next: null, pct: 100, remaining: 0 }
  const span = next.min - held.min
  const climbed = Math.max(0, totalSpent - held.min)
  const pct = Math.max(2, Math.min(100, Math.round((climbed / span) * 100)))
  return { next, pct, remaining: Math.max(0, next.min - totalSpent) }
}

// ── guest outreach links (Egyptian numbers → international dialing) ──

/** tel: href — digits/spaces only, safe in href. */
export function telHref(phone: string): string {
  const digits = phone.replace(/[^\d+]/g, '')
  return `tel:${digits}`
}

/**
 * wa.me href — Egyptian local numbers (leading 0) become +20;
 * already-international numbers pass through.
 */
export function whatsappHref(phone: string): string {
  let digits = phone.replace(/\D/g, '')
  if (digits.startsWith('20')) return `https://wa.me/${digits}`
  if (digits.startsWith('0')) digits = `20${digits.slice(1)}`
  return `https://wa.me/${digits}`
}
