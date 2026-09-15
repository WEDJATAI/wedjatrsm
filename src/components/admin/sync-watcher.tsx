'use client'

// ─── R15: global auto-export watcher ────────────────────────────────
// Mounted once by the app shell; renders nothing. When the user has
// settings permission AND auto-export is on AND a cloud target exists
// AND the browser is online AND there are pending changes → pushes a
// delta bundle to the cloud exactly once per pending-count change.
// Also refetches sync status the moment connectivity returns (the
// "connected to the internet → export all updates" moment). Silent
// otherwise; never throws.

import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { apiFetch, fetcher } from '@/lib/api'
import type { SessionUser, SyncImportSummary, SyncSettingsDTO } from '@/lib/types'
import { useI18n } from '@/lib/i18n'

/** Sum the values of a per-table count record ({"orders": 3, …} → n). */
function sumCounts(record: Record<string, number>): number {
  return Object.values(record).reduce((a, b) => a + b, 0)
}

export function SyncWatcher() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  // ── permission self-check (idle for users without settings access) ──
  const sessionQuery = useQuery({
    queryKey: ['session'],
    queryFn: () => fetcher<{ user: SessionUser }>('/api/auth/me'),
    retry: false,
    staleTime: 5 * 60_000,
  })
  const canSync =
    sessionQuery.isSuccess && (sessionQuery.data?.user?.permissions?.includes('settings') ?? false)

  // ── sync status (60s poll; shares the ['sync-status'] cache with the card) ──
  const statusQuery = useQuery({
    queryKey: ['sync-status'],
    queryFn: () => fetcher<{ sync: SyncSettingsDTO }>('/api/sync/status'),
    refetchInterval: 60_000,
    enabled: canSync,
    retry: false,
  })

  // ── connectivity: refetch status the moment we go online ──
  useEffect(() => {
    if (!canSync) return
    const onOnline = () => {
      void queryClient.invalidateQueries({ queryKey: ['sync-status'] })
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [canSync, queryClient])

  // ── auto-export trigger (guarded, once per pending-count change) ──
  const pushingRef = useRef(false)
  const lastPushedTotalRef = useRef<number | null>(null)
  const sync = statusQuery.data?.sync

  useEffect(() => {
    if (!sync || pushingRef.current) return
    if (!sync.autoExport || !sync.targetUrl) return
    if (typeof navigator !== 'undefined' && !navigator.onLine) return
    if (!(sync.pending.total > 0)) return
    // Already attempted this exact pending total (success or failure) —
    // wait for the count to change before pushing again.
    if (lastPushedTotalRef.current === sync.pending.total) return

    pushingRef.current = true
    apiFetch<{ ok: true; target: string; summary: SyncImportSummary }>('/api/sync/push', {
      body: { mode: 'delta' },
    })
      .then((res) => {
        toast.success(
          t('sync.watcherPushed', {
            n: sumCounts(res.summary.inserted) + sumCounts(res.summary.updated),
          }),
        )
      })
      .catch((err: Error) => {
        toast.error(t('sync.watcherFailed', { error: err.message }))
      })
      .finally(() => {
        lastPushedTotalRef.current = sync.pending.total
        pushingRef.current = false
        void queryClient.invalidateQueries({ queryKey: ['sync-status'] })
      })
  }, [sync, queryClient, t])

  return null
}
