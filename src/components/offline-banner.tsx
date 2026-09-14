'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { CloudOff, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { useI18n } from '@/lib/i18n'
import {
  flushOfflineQueue,
  offlineQueueCount,
  offlineQueueSnapshot,
  subscribeOfflineQueue,
} from '@/lib/offline-queue'

function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  const unsubQueue = subscribeOfflineQueue(onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
    unsubQueue()
  }
}

/** cached snapshot — useSyncExternalStore requires referential stability
 *  whenever the underlying values are unchanged (new object = infinite loop). */
let bannerCache: { online: boolean; count: number } | null = null

function snapshot(): { online: boolean; count: number } {
  const next = {
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    count: offlineQueueSnapshot().length,
  }
  if (bannerCache && bannerCache.online === next.online && bannerCache.count === next.count) {
    return bannerCache
  }
  bannerCache = next
  return next
}

/** SSR-safe server snapshot (never rendered on the server anyway). */
function serverSnapshot(): { online: boolean; count: number } {
  return { online: true, count: 0 }
}

/**
 * R13 PWA — offline queue banner. Fixed at the bottom of the viewport while
 * the terminal is offline with queued POS actions (aria-live so screen
 * readers announce connectivity changes). On reconnect it flushes the queue
 * and refreshes every query so open views catch up. Failed items stay
 * queued (order-preserving) and retry on the next reconnect/reload.
 */
export default function OfflineBanner() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [syncing, setSyncing] = useState(false)
  const state = useSyncExternalStore(subscribe, snapshot, serverSnapshot)

  // Flush on the offline→online transition, plus once shortly after mount
  // (covers a reload that happened while items were already queued). All
  // setState calls live inside async callbacks — never during the effect.
  useEffect(() => {
    let cancelled = false
    const runFlush = async () => {
      if (offlineQueueCount() === 0) return
      setSyncing(true)
      try {
        const result = await flushOfflineQueue()
        if (cancelled) return
        await queryClient.invalidateQueries()
        if (result.sent > 0) {
          toast.success(t('offline.synced', { n: result.sent }))
        }
        if (result.failed > 0) {
          toast.error(t('offline.syncFailed'))
        }
      } finally {
        if (!cancelled) setSyncing(false)
      }
    }
    const onOnline = () => void runFlush()
    window.addEventListener('online', onOnline)
    const mountTimer = setTimeout(() => {
      if (navigator.onLine) void runFlush()
    }, 800)
    return () => {
      cancelled = true
      window.removeEventListener('online', onOnline)
      clearTimeout(mountTimer)
    }
  }, [queryClient, t])

  if (state.online && state.count === 0) return null

  if (state.online) {
    // online with queued items → a flush is running (or just failed; the
    // toast reported it — items stay queued for the next reconnect)
    return (
      <div
        role="status"
        aria-live="polite"
        className="fixed inset-x-0 bottom-0 z-[80] flex items-center justify-center gap-2 border-t border-amber-300 bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-900"
      >
        <Loader2 className="size-4 animate-spin" aria-hidden />
        {t('offline.sending')}
      </div>
    )
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-0 z-[80] flex items-center justify-center gap-2 border-t border-amber-300 bg-amber-50 px-4 py-2.5 text-sm font-medium text-amber-900"
      style={{ paddingBottom: 'calc(0.625rem + env(safe-area-inset-bottom))' }}
    >
      <CloudOff className="size-4 shrink-0" aria-hidden />
      {state.count > 0 ? t('offline.banner', { n: state.count }) : t('offline.offlineIdle')}
    </div>
  )
}
