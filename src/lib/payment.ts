/**
 * R26 Payment Pro — shared payment helpers (client + server safe).
 *
 * 1. Auto payment references: `{METHOD}-{YYYYMMDD}-{HHmmss}-{tag}` —
 *    timestamp + payment-type code, generated SERVER-side for every POS
 *    payment so receipts, refunds and the drawer ledger all match.
 * 2. EGP change breakdown: greedy denomination split so the waiter can
 *    count change back without doing any math.
 * 3. Quick tender chips: the round amounts a guest most likely hands over
 *    for a given remaining balance.
 */

/** Reference codes per payment method (timestamp + type code refs). */
export const PAYMENT_REF_CODES: Record<string, string> = {
  cash: 'CASH',
  card: 'CARD',
  other: 'OTHR',
  loyalty: 'LOYL',
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/**
 * Build a payment reference: `{CODE}-{YYYYMMDD}-{HHmmss}-{tag}` e.g.
 * `CASH-20260215-143205-K7M`. The 3-char tag makes same-second splits
 * (equal-split N payers, one POST) collision-proof.
 */
export function paymentReference(method: string, when: Date = new Date()): string {
  const code = PAYMENT_REF_CODES[method] ?? 'OTHR'
  const date = `${when.getFullYear()}${pad2(when.getMonth() + 1)}${pad2(when.getDate())}`
  const time = `${pad2(when.getHours())}${pad2(when.getMinutes())}${pad2(when.getSeconds())}`
  const tag = Math.random().toString(36).slice(2, 5).toUpperCase()
  return `${code}-${date}-${time}-${tag}`
}

/** Loose shape check for R26 references (display hint, not validation). */
export function isPaymentRefFormat(ref: string | null | undefined): boolean {
  return typeof ref === 'string' && /^(CASH|CARD|OTHR|LOYL)-\d{8}-\d{6}-[A-Z0-9]{3}$/.test(ref)
}

// ─── Change breakdown ────────────────────────────────────────────────

/** EGP notes & coins in circulation, largest first. */
export const EGP_DENOMINATIONS = [200, 100, 50, 20, 10, 5, 1, 0.5, 0.25] as const

export type DenominationPart = { denom: number; count: number }

/**
 * Greedy breakdown of a change amount into EGP denominations.
 * Residuals under 25pt (impossible amounts) are absorbed by rounding the
 * last part count up — the waiter never sees a "leftover" line.
 */
export function breakdownChange(change: number): DenominationPart[] {
  let rest = Math.round(Math.max(0, change) * 100) / 100
  const out: DenominationPart[] = []
  for (const d of EGP_DENOMINATIONS) {
    if (rest + 1e-9 >= d) {
      const count = Math.floor((rest + 1e-9) / d)
      if (count > 0) {
        rest = Math.round((rest - count * d) * 100) / 100
        out.push({ denom: d, count })
      }
    }
    if (rest <= 0.001) break
  }
  // sub-piastre residual → hand the guest one more of the smallest part
  if (rest > 0.001 && out.length > 0) {
    out[out.length - 1] = { ...out[out.length - 1], count: out[out.length - 1].count + 1 }
  }
  return out
}

/**
 * Human denomination label: `50` → "EGP 50", `0.5` → "50pt", `0.25` → "25pt".
 * (pt = piastres — the local term every Egyptian waiter knows.)
 */
export function denomLabel(denom: number): string {
  if (denom >= 1) return `EGP ${denom % 1 === 0 ? denom : denom.toFixed(2)}`
  return `${Math.round(denom * 100)}pt`
}

// ─── Quick tender chips ──────────────────────────────────────────────

/** Round-up steps considered for quick chips (EGP bill denominations). */
const TENDER_STEPS = [10, 50, 100, 200, 500, 1000] as const

const round2n = (x: number): number => Math.round(x * 100) / 100

/**
 * Up to 3 smart round-up amounts a guest might hand over for `remaining`
 * (e.g. remaining 432.50 → [440, 450, 500]; remaining 38 → [40, 50, 100]).
 * Always ascending, deduped, each strictly above the remaining balance.
 */
export function quickTenderChips(remaining: number): number[] {
  const rem = round2n(Math.max(0, remaining))
  const chips = new Set<number>()
  for (const step of TENDER_STEPS) {
    const next = round2n(Math.ceil((rem + 0.001) / step) * step)
    if (next > rem) chips.add(next)
    if (chips.size >= 3) break
  }
  return [...chips].sort((a, b) => a - b)
}
