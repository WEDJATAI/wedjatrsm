'use client'

import { useEffect } from 'react'

/**
 * R13 PWA — register the service worker after the app mounts. Registration
 * is allowed in dev too: the SW itself refuses to cache no-store HTML, so
 * hot reload is unaffected (verified in the E2E pass).
 */
export default function PwaRegister() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return
    const register = () => {
      navigator.serviceWorker.register('/sw.js').catch(() => undefined)
    }
    if (document.readyState === 'complete') register()
    else {
      window.addEventListener('load', register, { once: true })
      return () => window.removeEventListener('load', register)
    }
  }, [])
  return null
}
