'use client'

import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChefHat } from 'lucide-react'
import { toast } from 'sonner'

import { KitchenOrderCard, type CourseFilter } from '@/components/kitchen/kitchen-order-card'
import { Badge } from '@/components/ui/badge'
import { apiFetch, fetcher } from '@/lib/api'
import { COURSES, type ItemStatus } from '@/lib/constants'
import type { Order, OrderItem } from '@/lib/types'
import { cn } from '@/lib/utils'

const FILTER_LABELS: Record<CourseFilter, string> = {
  all: 'All',
  starter: 'Starters',
  main: 'Mains',
  dessert: 'Desserts',
  drink: 'Drinks',
}

const COURSE_FILTERS: CourseFilter[] = ['all', ...COURSES]

/** Kitchen Display System — dark kitchen screen (by design, not dark mode). */
export default function KitchenView() {
  const queryClient = useQueryClient()
  const [courseFilter, setCourseFilter] = useState<CourseFilter>('all')
  const [clock, setClock] = useState(() => new Date())
  const [tick, setTick] = useState(0)

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
      toast.error(mutationError.message || 'Failed to update item')
      if (context?.previous) {
        queryClient.setQueryData(['orders', 'open'], context.previous)
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['orders', 'open'] })
    },
  })

  const pendingItemId = statusMutation.isPending ? (statusMutation.variables?.id ?? null) : null

  const clockText = clock.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })

  return (
    <section className="min-h-[calc(100vh-4rem)] bg-zinc-950 p-4 text-zinc-100 sm:p-6">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3 sm:mb-6">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-amber-500 text-zinc-950 shadow-lg shadow-amber-500/20">
            <ChefHat className="size-6" />
          </div>
          <h1 className="text-xl font-bold">Kitchen Display</h1>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-400">
            <span className="relative flex size-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
            </span>
            live · 3s
          </span>
          <Badge variant="outline" className="border-zinc-700 bg-zinc-900 text-zinc-400">
            {orders.length} open · {pendingItemCount} items pending
          </Badge>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="text-2xl font-mono font-bold tabular-nums text-zinc-100">{clockText}</div>
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
                  {FILTER_LABELS[filter]}
                </button>
              )
            })}
          </div>
        </div>
      </header>

      {isError && (
        <div className="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-400">
          {error instanceof Error ? error.message : 'Failed to load open orders'}
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
          <p className="text-lg text-zinc-500">No open orders — all caught up!</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {sortedOrders.map((order) => (
            <KitchenOrderCard
              key={order.id}
              order={order}
              tick={tick}
              courseFilter={courseFilter}
              pendingItemId={pendingItemId}
              onUpdateItemStatus={(id, status) => statusMutation.mutate({ id, status })}
            />
          ))}
        </div>
      )}
    </section>
  )
}
