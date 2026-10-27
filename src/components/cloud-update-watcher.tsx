'use client'

// ─── R61: cloud-update watcher — the desktop notification feed ──────
// Owner directive: "If anything has been modified on cloud it has to be
// synced to desktop too and automatically update it. Also if there are any
// updates for the cloud, a notification on the desktop version and updates
// automatically."
//
// Mounted once by the app shell (next to SyncWatcher); renders nothing.
// The hybrid engine already pulls cloud changes into the local database
// every 30 s — this watcher makes that VISIBLE on terminal planes (the
// desktop install, the local sandbox):
//
//   · polls /api/hybrid/updates every 20 s (any logged-in session; the
//     endpoint is plane-aware and answers mode 'hub' on the cloud, where
//     the watcher stays silent — cloud users originate their own edits)
//   · when dataVersion advances: toast "Updated from cloud — N change(s):
//     menu, orders…" AND invalidate the whole query cache, so an open POS,
//     Menu admin, Kitchen display… live-refresh with the cloud's state
//   · bulk catch-up (fresh install replaying thousands of events) stays
//     quiet by design — the launcher pill already shows "Sync catching up"
//
// Never throws; a failed poll (offline, 401) is silent — the sync pill and
// offline banner own connectivity messaging.

import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { fetcher } from '@/lib/api'
import { useI18n } from '@/lib/i18n'

type UpdatesDTO =
  | { mode: 'hub' }
  | {
      mode: 'terminal'
      dataVersion: number
      lastAppliedAt: string | null
      lastAppliedEntities: string[]
      lastPullAt: string | null
      cloudReachable: string | null
      /** r62: set when a menu.reimport audit event was applied this window */
      menuReimportAt?: string | null
    }

/** Hybrid entity name → human area (i18n key suffix). */
const ENTITY_AREA: Record<string, string> = {
  Category: 'menu',
  Product: 'menu',
  ModifierGroup: 'menu',
  Modifier: 'menu',
  RecipeComponent: 'menu',
  Order: 'orders',
  OrderItem: 'orders',
  Payment: 'orders',
  RestaurantTable: 'tables',
  FloorPlan: 'tables',
  FloorSpace: 'tables',
  Customer: 'customers',
  Person: 'people',
  Attendance: 'people',
  Shift: 'people',
  Promotion: 'promotions',
}

/** Above this many applied events in ONE 20 s window we assume catch-up. */
const BULK_THRESHOLD = 100

export function CloudUpdateWatcher() {
  const { t, lang } = useI18n()
  const queryClient = useQueryClient()

  const sessionQuery = useQuery({
    queryKey: ['session'],
    queryFn: () => fetcher<{ user: unknown }>('/api/auth/me'),
    retry: false,
    staleTime: 5 * 60_000,
  })
  const hasSession = sessionQuery.isSuccess && sessionQuery.data != null

  const updatesQuery = useQuery({
    queryKey: ['hybrid-updates'],
    queryFn: () => fetcher<UpdatesDTO>('/api/hybrid/updates'),
    refetchInterval: 20_000,
    staleTime: 15_000,
    retry: false,
    enabled: hasSession,
  })

  const lastVersionRef = useRef<number | null>(null)
  // r62: last menu-reimport stamp seen — a change means a full menu update
  // (attachment/reimport) just landed, and that deserves its OWN toast even
  // when the event count lands in the bulk-catch-up silence band (400+).
  const lastMenuReimportRef = useRef<string | null>(null)

  useEffect(() => {
    const data = updatesQuery.data
    if (!data || data.mode !== 'terminal') return
    const version = data.dataVersion

    // first observation after (re)load: baseline only — events that landed
    // while the page was closed are already in the fetched views.
    if (lastVersionRef.current === null) {
      lastVersionRef.current = version
      if (data.menuReimportAt) lastMenuReimportRef.current = data.menuReimportAt
      return
    }
    if (version <= lastVersionRef.current && !data.menuReimportAt) return

    const delta = version - lastVersionRef.current
    const menuReimportChanged =
      !!data.menuReimportAt && data.menuReimportAt !== lastMenuReimportRef.current
    if (delta <= 0 && !menuReimportChanged) return
    lastVersionRef.current = version
    if (data.menuReimportAt) lastMenuReimportRef.current = data.menuReimportAt

    // every open view re-reads the freshly applied state — this is the
    // "automatically update it" half, independent of any toast.
    void queryClient.invalidateQueries()

    // r62: a menu reimport (attachment) is THE update the owner wants to hear
    // about — dedicated toast, even inside the bulk band.
    if (menuReimportChanged) {
      toast.success(t('sync.cloudUpdate.menuToast.title'), {
        description: t('sync.cloudUpdate.menuToast.body'),
      })
      return
    }

    // bulk catch-up (fresh-install bootstrap replay): stay quiet, the
    // launcher pill shows "Sync catching up" for exactly this window.
    if (delta > BULK_THRESHOLD) return

    const areas = new Set(
      (data.lastAppliedEntities ?? []).map((e) => ENTITY_AREA[e] ?? 'other'),
    )
    const areaKeys = [...areas].slice(0, 3).map((a) => t(`sync.cloudUpdate.areas.${a}`))
    if (areas.size > 3) areaKeys.push(t('sync.cloudUpdate.areas.other'))

    const isArabic = lang === 'ar'
    const body = t('sync.cloudUpdate.body', {
      n: String(delta),
      areas: isArabic ? areaKeys.reverse().join('، ') : areaKeys.join(', '),
    })
    toast.success(t('sync.cloudUpdate.title'), { description: body })
  }, [updatesQuery.data, queryClient, t, lang])

  return null
}
