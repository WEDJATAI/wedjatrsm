import * as React from "react"

const MOBILE_BREAKPOINT = 768
const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

function subscribe(callback: () => void) {
  const mql = window.matchMedia(QUERY)
  mql.addEventListener("change", callback)
  return () => mql.removeEventListener("change", callback)
}

export function useIsMobile() {
  // r49: useSyncExternalStore — the modern viewport hook (react-hooks v6
  // compliant: no synchronous setState inside an effect). During hydration
  // React uses the server snapshot (false), then re-renders with the live
  // media query result — same one-tick convergence as the old effect-based
  // version, without the cascading render.
  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false
  )
}
