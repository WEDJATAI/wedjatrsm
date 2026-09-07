'use client'

// ─── Formatting helpers (client-safe) ───────────────────────────────

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-EG', {
    style: 'currency',
    currency: 'EGP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(amount) ? amount : 0)
}

export function formatQty(q: number): string {
  return Number.isInteger(q) ? String(q) : q.toFixed(2).replace(/\.?0+$/, '')
}

export function formatTime(date: string | Date): string {
  return new Date(date).toLocaleTimeString('en-EG', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export function formatDate(date: string | Date): string {
  return new Date(date).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

export function formatDateTime(date: string | Date): string {
  return `${formatDate(date)} ${formatTime(date)}`
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
