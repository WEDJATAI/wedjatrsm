'use client'

// ─── Formatting helpers (client-safe, locale-aware) ─────────────────

export type FormatLang = 'en' | 'ar'

let currentLang: FormatLang = 'en'

/**
 * Set the active formatting locale (called by the LanguageProvider).
 * Arabic uses Latin digits (common in Egyptian retail) with the ج.م symbol.
 */
export function setFormatLocale(lang: FormatLang): void {
  currentLang = lang
}

/** Currently active formatting locale. */
export function formatLocale(): FormatLang {
  return currentLang
}

const AR_LOCALE = 'ar-EG-u-nu-latn'
const DATE_LOCALES: Record<FormatLang, string> = { en: 'en-GB', ar: AR_LOCALE }
const CURRENCY_LOCALES: Record<FormatLang, string> = { en: 'en-EG', ar: AR_LOCALE }

export function formatCurrency(amount: number, lang?: FormatLang): string {
  const locale = CURRENCY_LOCALES[lang ?? currentLang]
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'EGP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(amount) ? amount : 0)
}

export function formatQty(q: number): string {
  return Number.isInteger(q) ? String(q) : q.toFixed(2).replace(/\.?0+$/, '')
}

export function formatTime(date: string | Date, lang?: FormatLang): string {
  return new Date(date).toLocaleTimeString(DATE_LOCALES[lang ?? currentLang], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export function formatDate(date: string | Date, lang?: FormatLang): string {
  return new Date(date).toLocaleDateString(DATE_LOCALES[lang ?? currentLang], {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

export function formatDateTime(date: string | Date, lang?: FormatLang): string {
  return `${formatDate(date, lang)} ${formatTime(date, lang)}`
}

/** Minutes elapsed since the given date, e.g. "3m 12s" or "1h 05m". */
export function elapsedSince(date: string | Date): string {
  const ms = Date.now() - new Date(date).getTime()
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  return `${m}m ${String(s).padStart(2, '0')}s`
}

/** Elapsed minutes as a number (for color coding). */
export function elapsedMinutes(date: string | Date): number {
  return Math.floor((Date.now() - new Date(date).getTime()) / 60000)
}

export function toDateInputValue(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Worked duration between two timestamps, e.g. "2h 15m" / "48m" (used by attendance). */
export function workedDuration(from: string | Date, to: string | Date): string {
  const ms = Math.max(0, new Date(to).getTime() - new Date(from).getTime())
  const totalMin = Math.floor(ms / 60000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  return `${m}m`
}
