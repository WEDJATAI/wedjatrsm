'use client'

/**
 * History-backed in-app navigation (Round 7). The app lives on a single
 * route ('/'), so the full navigation state is encoded in the location hash:
 *
 *   '#/pos'            POS floor (table select)
 *   '#/pos/order/12'   POS order screen for live order #12
 *   '#/pos/table/7'    POS draft screen on free table 7
 *   '#/pos/takeaway'   POS takeaway draft
 *   '#/kitchen'        other top-level views (view name = hash segment)
 *   '#/reports'        …
 *
 * pushNav() adds real history entries, so the browser/OS back button moves
 * within the app instead of leaving it; restoration is driven by popstate
 * (back/forward) + hashchange (hand-edited hashes).
 *
 * NOTE: a single back press can fire BOTH popstate and hashchange — all
 * onNav handlers MUST be idempotent (navigating to the state they are
 * already in is a no-op).
 */

export type NavHash = { view: string; sub: string | null }

const HASH_RE = /^#\/([a-z]+)(?:\/([^/].*))?$/

export function parseNavHash(hash: string): NavHash | null {
  const m = HASH_RE.exec(hash || '')
  return m ? { view: m[1], sub: m[2] ?? null } : null
}

export function currentNav(): NavHash | null {
  if (typeof window === 'undefined') return null
  return parseNavHash(window.location.hash)
}

export function navHashString(view: string, sub?: string | null): string {
  return `#/${view}${sub ? `/${sub}` : ''}`
}

/** Push a new in-app history entry (browser Back returns to the previous one). */
export function pushNav(view: string, sub?: string | null): void {
  if (typeof window === 'undefined') return
  const hash = navHashString(view, sub)
  if (window.location.hash === hash) return
  window.history.pushState({ rmsNav: true }, '', hash)
}

/** Rewrite the current history entry's hash (no extra back entry). */
export function replaceNav(view: string, sub?: string | null): void {
  if (typeof window === 'undefined') return
  const hash = navHashString(view, sub)
  if (window.location.hash === hash) return
  window.history.replaceState({ rmsNav: true }, '', hash)
}

/** Normalize a bare/invalid URL to the default view hash (first load). */
export function initNav(view: string): void {
  if (typeof window === 'undefined') return
  if (!currentNav()) replaceNav(view)
}

/** Drop the app hash (logout) so the next session starts clean. */
export function clearNav(): void {
  if (typeof window === 'undefined') return
  window.history.replaceState(null, '', window.location.pathname + window.location.search)
}

/**
 * Subscribe to in-app navigation changes (browser back/forward + hand-edited
 * hashes). Returns an unsubscribe function. Handlers must be idempotent.
 */
export function onNav(handler: (nav: NavHash | null) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const listener = () => handler(currentNav())
  window.addEventListener('popstate', listener)
  window.addEventListener('hashchange', listener)
  return () => {
    window.removeEventListener('popstate', listener)
    window.removeEventListener('hashchange', listener)
  }
}
