// ─── RSM service worker (R13 PWA) ────────────────────────────────────
// Conservative shell caching for tablet/phone installability:
//   • /_next/static + icons + manifest  → cache-first (immutable assets)
//   • navigations (HTML)                → network-first, cache fallback
//   • everything else (API, HMR, data)  → network only, NEVER cached
//
// Dev-mode safety: HTML served with Cache-Control: no-store is never put
// in the cache, so hot reload keeps working; the fetch handler ignores
// non-GET and cross-origin requests entirely.

const VERSION = 'rms-sw-v2'
const SHELL_CACHE = `${VERSION}-shell`
const ASSET_CACHE = `${VERSION}-assets`

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(SHELL_CACHE)
        await cache.addAll(['/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'])
      } catch {
        // offline-page caching is best-effort only
      }
      await self.skipWaiting()
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(
        keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key)),
      )
      await self.clients.claim()
    })(),
  )
})

function cacheableAsset(url) {
  return (
    url.pathname.startsWith('/_next/static/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.webmanifest'
  )
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // static assets → network-first with cache fallback (offline). Always
  // consulting the server keeps dev rebuilds fresh (Turbopack reuses chunk
  // filenames); offline installs still serve the last-known-good assets.
  if (cacheableAsset(url)) {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request)
          if (response.ok) {
            const cache = await caches.open(ASSET_CACHE)
            cache.put(request, response.clone()).catch(() => undefined)
          }
          return response
        } catch {
          const cached = await caches.match(request)
          if (cached) return cached
          return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })
        }
      })(),
    )
    return
  }

  // navigations → network-first with cache fallback (offline shell)
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request)
          const cacheControl = response.headers.get('cache-control') ?? ''
          if (response.ok && !cacheControl.includes('no-store')) {
            const cache = await caches.open(SHELL_CACHE)
            cache.put(request, response.clone()).catch(() => undefined)
          }
          return response
        } catch {
          const cached = await caches.match(request)
          if (cached) return cached
          return new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } })
        }
      })(),
    )
    return
  }

  // API + everything else: network only (offline order queue lives in the
  // app layer — localStorage — NOT in the SW, so replays keep auth cookies)
})
