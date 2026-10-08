// ─── R13: guided-tour event bus ──────────────────────────────────────
// Tiny module-level pub/sub so the navbar help button can start the tour
// from anywhere without prop drilling.

'use client'

const TOUR_EVENT = 'rms-tour-control'

export type TourControl = { command: 'start' }

export function startTour(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<TourControl>(TOUR_EVENT, { detail: { command: 'start' } }))
}

export function subscribeTourControl(handler: (control: TourControl) => void): () => void {
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<TourControl>).detail
    if (detail && typeof detail === 'object') handler(detail)
  }
  window.addEventListener(TOUR_EVENT, listener)
  return () => window.removeEventListener(TOUR_EVENT, listener)
}

/** localStorage key: has this user finished/skipped the first-run tour? */
export function tourDoneKey(userId: number): string {
  return `rms-tour-done-${userId}`
}

export function isTourDone(userId: number): boolean {
  if (typeof window === 'undefined') return true
  try {
    return window.localStorage.getItem(tourDoneKey(userId)) === '1'
  } catch {
    return true
  }
}

export function markTourDone(userId: number): void {
  try {
    window.localStorage.setItem(tourDoneKey(userId), '1')
  } catch {
    // storage unavailable — tour will show again next session (harmless)
  }
}
