// ─── AI Vision shared helpers (client-safe, no JSX) ──────────────────
// Local copies of the POS tile silhouette pattern + vision-specific
// formatters and badge class maps. Kept pure so every vision tab (and
// the POS movement chips) can share them without pulling POS code.

import type { QueryClient } from '@tanstack/react-query'

/** Minutes → '48m' / '1h 05m' / '—' when unknown. */
export function formatMinutes(min: number | null | undefined): string {
  if (min == null || !Number.isFinite(min)) return '—'
  const total = Math.max(0, Math.round(min))
  if (total < 60) return `${total}m`
  const h = Math.floor(total / 60)
  const m = total % 60
  return `${h}h ${String(m).padStart(2, '0')}m`
}

/** Percent → '87%' with clamping + Latin digits. */
export function formatPct(pct: number | null | undefined): string {
  if (pct == null || !Number.isFinite(pct)) return '—'
  return `${Math.round(Math.min(100, Math.max(0, pct)))}%`
}

/** 0..1 → '95%' confidence label. */
export function formatConfidence(c: number | null | undefined): string {
  if (c == null || !Number.isFinite(c)) return '—'
  return `${Math.round(Math.min(1, Math.max(0, c)) * 100)}%`
}

// ── Tile silhouettes (copied from POS table-select — same visual) ────
export const SHAPE_TILE_CLASSES: Record<string, string> = {
  square: 'aspect-square rounded-2xl',
  round: 'aspect-square rounded-full',
  rectangle: 'h-24 rounded-2xl',
  oval: 'h-24 rounded-full',
}

export function shapeClasses(shape: string): string {
  return SHAPE_TILE_CLASSES[shape] ?? SHAPE_TILE_CLASSES.square
}

// ── Badge class maps (warm palette — NO blue/indigo) ─────────────────

export function cameraStatusClass(status: string): string {
  switch (status) {
    case 'online':
      return 'border-emerald-300 bg-emerald-50 text-emerald-700'
    case 'error':
      return 'border-rose-300 bg-rose-50 text-rose-700'
    case 'disabled':
      return 'border-stone-200 bg-stone-100 text-stone-500'
    default:
      return 'border-stone-300 bg-stone-100 text-stone-600'
  }
}

export function movementStatusClass(status: string): string {
  switch (status) {
    case 'pending':
      return 'border-amber-300 bg-amber-50 text-amber-700'
    case 'confirmed':
      return 'border-emerald-300 bg-emerald-50 text-emerald-700'
    case 'conflict':
      return 'border-rose-300 bg-rose-50 text-rose-700'
    case 'expired':
      return 'border-stone-200 bg-stone-100 text-stone-500'
    default:
      return 'border-stone-300 bg-stone-100 text-stone-600'
  }
}

export function confidenceClass(c: number): string {
  if (c >= 0.9) return 'border-emerald-300 bg-emerald-50 text-emerald-700'
  if (c >= 0.7) return 'border-amber-300 bg-amber-50 text-amber-700'
  return 'border-stone-300 bg-stone-100 text-stone-600'
}

export function alertSeverityClass(severity: string): string {
  switch (severity) {
    case 'critical':
      return 'border-rose-300 bg-rose-50 text-rose-700'
    case 'warning':
      return 'border-amber-300 bg-amber-50 text-amber-700'
    default:
      return 'border-stone-300 bg-stone-100 text-stone-600'
  }
}

/** Dwell "heat" tint for observed-occupied tiles (mirrors the POS tile heat). */
export function visionHeat(stateSince: string | null): {
  tile: string
  meta: string
} | null {
  if (!stateSince) return { tile: 'border-emerald-300 bg-emerald-50', meta: 'text-emerald-700' }
  const mins = Math.max(0, (Date.now() - new Date(stateSince).getTime()) / 60000)
  if (mins < 15) return { tile: 'border-emerald-200 bg-emerald-50', meta: 'text-emerald-700' }
  if (mins < 45) return { tile: 'border-amber-200 bg-amber-50', meta: 'text-amber-700' }
  if (mins < 90) return { tile: 'border-orange-300 bg-orange-100', meta: 'text-orange-700' }
  return { tile: 'border-rose-300 bg-rose-100', meta: 'text-rose-700' }
}

/** Manual override hold active right now? */
export function isManualHoldActive(until: string | null): boolean {
  if (!until) return false
  return new Date(until).getTime() > Date.now()
}

/**
 * Invalidate everything a guest-move decision (confirm/reject/undo) can
 * touch: POS floor + orders + table statuses, the movement candidates and
 * the vision overview. Shared by the quick dialog, movements tab and the
 * POS floor chips.
 */
export async function invalidateAfterMovementDecision(qc: QueryClient): Promise<void> {
  await Promise.all([
    qc.invalidateQueries({ queryKey: ['vision-movements'] }),
    qc.invalidateQueries({ queryKey: ['vision-overview'] }),
    qc.invalidateQueries({ queryKey: ['floorplans'] }),
    qc.invalidateQueries({ queryKey: ['orders'] }),
    qc.invalidateQueries({ queryKey: ['pos-order'] }),
    qc.invalidateQueries({ queryKey: ['tables-status'] }),
  ])
}
