'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChefHat, Volume2, VolumeX } from 'lucide-react'
import { toast } from 'sonner'

import {
  KitchenOrderCard,
  STATION_PILL_ACTIVE_CLASSES,
  stationLabel,
  type CourseFilter,
  type StationFilter,
} from '@/components/kitchen/kitchen-order-card'
import { Badge } from '@/components/ui/badge'
import { apiFetch, fetcher } from '@/lib/api'
import { COURSES, prepStationOf, type ItemStatus } from '@/lib/constants'
import { haptic, sndAlert, sndTap } from '@/lib/feedback'
import { useI18n } from '@/lib/i18n'
import type { Order, OrderItem } from '@/lib/types'
import { cn } from '@/lib/utils'

const FILTER_LABEL_KEYS: Record<CourseFilter, string> = {
  all: 'kds.all',
  starter: 'kds.filterStarters',
  main: 'kds.filterMains',
  dessert: 'kds.filterDesserts',
  drink: 'kds.filterDrinks',
}

const COURSE_FILTERS: CourseFilter[] = ['all', ...COURSES]

/** R25: localStorage key for the KDS sound preference ('1' = on, '0' = muted). */
const KDS_SOUND_KEY = 'rms-kds-sound'

/** R25: how long a freshly arrived order wears its amber attention ring. */
const NEW_ORDER_HIGHLIGHT_MS = 12_000

/** Kitchen Display System — dark kitchen screen (by design, not dark mode). */
export default function KitchenView() {
  const { t, isRTL } = useI18n()
  const queryClient = useQueryClient()
  const [courseFilter, setCourseFilter] = useState<CourseFilter>('all')
  // R11: station routing filter — 'all' or a station slug (kitchen/bar/
  // shisha/custom). Filters the ITEMS inside the order cards exactly like
  // the course filter does.
  const [stationFilter, setStationFilter] = useState<StationFilter>('all')
  const [clock, setClock] = useState(() => new Date())
  const [tick, setTick] = useState(0)

  // R25: sound preference — persisted per device so a shift's setting
  // survives reloads (default ON; '0' = muted). Lazy initializer + a
  // typeof-window guard keep the server-rendered first pass safe.
  const [soundOn, setSoundOn] = useState(() => {
    if (typeof window === 'undefined') return true
    try {
      return window.localStorage.getItem(KDS_SOUND_KEY) !== '0'
    } catch {
      return true // storage blocked (private mode) — stay ON this session
    }
  })

  // R25: new-order feedback state — order ids currently wearing the amber
  // ring, the previous snapshot's open-order ids (detection baseline), and
  // one ring-removal timer per highlighted id.
  const [highlightedIds, setHighlightedIds] = useState<ReadonlySet<number>>(() => new Set())
  const seenOrderIdsRef = useRef<Set<number> | null>(null)
  const highlightTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())

  // Live clock — every second.
  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  // Bump tick every 5s so elapsed timers on order cards re-render.
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 5000)
    return () => clearInterval(timer)
  }, [])

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['orders', 'open'],
    queryFn: () => fetcher<{ orders: Order[] }>('/api/orders?status=open'),
    refetchInterval: 3000,
  })

  const orders = useMemo(() => data?.orders ?? [], [data])

  // R25: NEW-ORDER DETECTION — the kitchen must HEAR + SEE fresh work the
  // second it lands. Each data snapshot is diffed by order id: an id never
  // seen before is a genuinely new order → triple chime (sndAlert, only
  // when sound is on) + haptic buzz + a 12s amber ring on its card.
  // False positives are impossible by construction:
  //   · the FIRST snapshot only primes the seen-set — opening the KDS
  //     must not chime for orders that already exist;
  //   · ids are only ever ADDED to the set, so an order that leaves the
  //     open list and comes back (refetch, filter change) can't re-fire;
  //   · detection reads the raw `data` — course/station filters are
  //     purely visual and never touch this effect.
  useEffect(() => {
    if (!data) return // no snapshot yet
    const ids = data.orders.map((order) => order.id)
    const seen = seenOrderIdsRef.current
    if (seen === null) {
      seenOrderIdsRef.current = new Set(ids)
      return
    }
    const newIds = ids.filter((id) => !seen.has(id))
    if (newIds.length === 0) return
    for (const id of newIds) seen.add(id)

    // Chime + toast only when sound is enabled; haptics are silent, and
    // the amber ring shows either way (muted ≠ invisible).
    if (soundOn) {
      sndAlert()
      toast(t('kds.newOrderAlert')) // one toast per batch, not per order
    }
    haptic([30, 50, 30])

    setHighlightedIds((prev) => {
      const next = new Set(prev)
      for (const id of newIds) next.add(id)
      return next
    })
    // Each ring removes itself after 12s; timers are tracked so unmount
    // (view switch) can cancel them before they touch a dead component.
    const timers = highlightTimersRef.current
    for (const id of newIds) {
      const timer = setTimeout(() => {
        timers.delete(id)
        setHighlightedIds((prev) => {
          if (!prev.has(id)) return prev
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }, NEW_ORDER_HIGHLIGHT_MS)
      timers.set(id, timer)
    }
  }, [data, soundOn, t])

  // R25: cancel pending ring timers when the KDS unmounts — a late
  // setTimeout would call setState on a dead component (React warning).
  useEffect(() => {
    const timers = highlightTimersRef.current
    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  }, [])

  // R25: flip + persist the sound preference. Switching sound back ON
  // plays an immediate tick so staff can CONFIRM the board is audible
  // (switching it off is, by definition, silent).
  const toggleSound = () => {
    const next = !soundOn
    setSoundOn(next)
    if (next) sndTap()
    try {
      window.localStorage.setItem(KDS_SOUND_KEY, next ? '1' : '0')
    } catch {
      // best-effort persistence — the choice still applies this session
    }
  }

  // R11: distinct prep stations across the open orders' items (each item's
  // product category routes it; null/absent → kitchen).
  const stations = useMemo(() => {
    const set = new Set<string>()
    for (const order of orders) {
      for (const item of order.items) {
        set.add(prepStationOf(item.product?.category?.prepDestination))
      }
    }
    // stable display order: presets first, then custom slugs alphabetically
    const presetOrder = ['kitchen', 'bar', 'shisha']
    return [...set].sort((a, b) => {
      const ai = presetOrder.indexOf(a)
      const bi = presetOrder.indexOf(b)
      if (ai !== -1 && bi !== -1) return ai - bi
      if (ai !== -1) return -1
      if (bi !== -1) return 1
      return a.localeCompare(b)
    })
  }, [orders])

  // Oldest first; fully-served orders sink to the end.
  const sortedOrders = useMemo(() => {
    const isDone = (order: Order) =>
      order.items.length > 0 && order.items.every((item) => item.status === 'served')
    return [...orders].sort((a, b) => {
      const aDone = isDone(a)
      const bDone = isDone(b)
      if (aDone !== bDone) return aDone ? 1 : -1
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    })
  }, [orders])

  const pendingItemCount = orders.reduce(
    (sum, order) => sum + order.items.filter((item) => item.status !== 'served').length,
    0,
  )

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: ItemStatus }) =>
      apiFetch<{ item: OrderItem }>(`/api/order-items/${id}`, {
        method: 'PUT',
        body: { status },
      }),
    onMutate: async ({ id, status }) => {
      await queryClient.cancelQueries({ queryKey: ['orders', 'open'] })
      const previous = queryClient.getQueryData<{ orders: Order[] }>(['orders', 'open'])
      if (previous) {
        queryClient.setQueryData(['orders', 'open'], {
          ...previous,
          orders: previous.orders.map((order) => ({
            ...order,
            items: order.items.map((item) => (item.id === id ? { ...item, status } : item)),
          })),
        })
      }
      return { previous }
    },
    onError: (mutationError, _variables, context) => {
      toast.error(mutationError.message || t('kds.updateFailed'))
      if (context?.previous) {
        queryClient.setQueryData(['orders', 'open'], context.previous)
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['orders', 'open'] })
    },
  })

  const pendingItemId = statusMutation.isPending ? (statusMutation.variables?.id ?? null) : null

  const clockText = clock.toLocaleTimeString(isRTL ? 'ar-EG-u-nu-latn' : 'en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })

  return (
    <section className="min-h-[calc(100vh-4rem)] bg-zinc-950 p-4 text-zinc-100 sm:p-6">
      {/* R13 (P3): sticky header + station pills — stays visible while
          scrolling long boards. Solid-enough backdrop so cards NEVER show
          through, z-40 above the grid, border separates it visually. */}
      <div className="sticky top-16 z-40 -mx-4 mb-4 border-b border-zinc-800/70 bg-zinc-950/95 px-4 pb-4 pt-1 backdrop-blur supports-[backdrop-filter]:bg-zinc-950/85 sm:-mx-6 sm:px-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-amber-500 text-zinc-950 shadow-lg shadow-amber-500/20">
              <ChefHat className="size-6" />
            </div>
            <h1 className="text-xl font-bold">{t('kds.title')}</h1>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-400">
              <span className="relative flex size-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
              </span>
              {t('kds.live3s')}
            </span>
            <Badge variant="outline" className="border-zinc-700 bg-zinc-900 text-zinc-400">
              {t('kds.stats', { n: orders.length, m: pendingItemCount })}
            </Badge>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <div className="text-2xl font-mono font-bold tabular-nums text-zinc-100">{clockText}</div>

            {/* R25: sound toggle — the triple chime (sndAlert) rings when a
                new order lands; muted keeps only the amber ring + haptics.
                Styled exactly like the course filter pills (amber = active)
                so the dark KDS header stays coherent. */}
            <button
              type="button"
              onClick={toggleSound}
              aria-pressed={soundOn}
              title={soundOn ? t('kds.soundOn') : t('kds.soundOff')}
              aria-label={soundOn ? t('kds.soundOn') : t('kds.soundOff')}
              className={cn(
                'flex size-11 shrink-0 items-center justify-center rounded-full border transition-colors',
                soundOn
                  ? 'border-amber-500 bg-amber-500 text-zinc-950 hover:bg-amber-400'
                  : 'border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200',
              )}
            >
              {soundOn ? (
                <Volume2 className="size-5" aria-hidden="true" />
              ) : (
                <VolumeX className="size-5" aria-hidden="true" />
              )}
            </button>
            <div className="flex flex-wrap items-center gap-2">
              {COURSE_FILTERS.map((filter) => {
                const active = courseFilter === filter
                return (
                  <button
                    key={filter}
                    type="button"
                    onClick={() => setCourseFilter(filter)}
                    className={cn(
                      'h-11 rounded-full border px-4 text-sm font-medium transition-colors',
                      active
                        ? 'border-amber-500 bg-amber-500 text-zinc-950'
                        : 'border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200',
                    )}
                  >
                    {t(FILTER_LABEL_KEYS[filter])}
                  </button>
                )
              })}
            </div>
          </div>
        </header>

        {/* ── R11: station routing pills (kitchen / bar / shisha / custom) —
            a second filter row; filters items inside the cards like courses.
            Sticky-safe with the header (R13). ── */}
        {stations.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {(['all', ...stations] as StationFilter[]).map((station) => {
              const active = stationFilter === station
              const label = station === 'all' ? t('kds.stationAll') : stationLabel(station, t)
              return (
                <button
                  key={station}
                  type="button"
                  onClick={() => setStationFilter(station)}
                  aria-pressed={active}
                  className={cn(
                    'h-11 rounded-full border px-4 text-sm font-medium transition-colors',
                    active
                      ? station === 'all'
                        ? 'border-emerald-500 bg-emerald-500 text-zinc-950'
                        : STATION_PILL_ACTIVE_CLASSES[station] ?? 'border-sky-400 bg-sky-400 text-zinc-950'
                      : 'border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200',
                  )}
                >
                  {label}
                </button>
              )
            })}
          </div>
        )}
      </div>

      {isError && (
        <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-400">
          {error instanceof Error ? error.message : t('kds.loadFailed')}
        </div>
      )}

      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {Array.from({ length: 6 }).map((_, index) => (
            <div
              key={index}
              className="h-64 animate-pulse rounded-xl border border-zinc-800 bg-zinc-900"
            />
          ))}
        </div>
      ) : sortedOrders.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
          <ChefHat className="size-24 text-zinc-800" strokeWidth={1} />
          <p className="text-lg text-zinc-500">{t('kds.empty')}</p>
          {/* R13: empty-state coaching (learnability) */}
          <p className="max-w-sm text-sm text-zinc-600">{t('kds.emptyHint')}</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {sortedOrders.map((order) => (
            <KitchenOrderCard
              key={order.id}
              order={order}
              tick={tick}
              courseFilter={courseFilter}
              stationFilter={stationFilter}
              pendingItemId={pendingItemId}
              onUpdateItemStatus={(id, status) => statusMutation.mutate({ id, status })}
              highlight={highlightedIds.has(order.id)}
            />
          ))}
        </div>
      )}
    </section>
  )
}
