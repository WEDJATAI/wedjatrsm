'use client'

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Clock, MapPin, Plus, ShoppingBag, Utensils } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { fetcher } from '@/lib/api'
import { TABLE_STATUS_LABELS } from '@/lib/constants'
import { elapsedSince, formatCurrency } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { FloorPlan, Order, RestaurantTable } from '@/lib/types'

type TableSelectProps = {
  onSelectTable: (table: RestaurantTable) => void
  onTakeaway: () => void
  onOpenTakeawayOrder: (order: Order) => void
}

export default function TableSelect({ onSelectTable, onTakeaway, onOpenTakeawayOrder }: TableSelectProps) {
  const [activeFloorPlan, setActiveFloorPlan] = useState<string | null>(null)

  const { data: floorPlanData, isLoading } = useQuery({
    queryKey: ['floorplans'],
    queryFn: () => fetcher<{ floorPlans: FloorPlan[] }>('/api/floorplans'),
    refetchInterval: 3000, // LIVE table statuses
  })

  const { data: openOrdersData } = useQuery({
    queryKey: ['orders', 'open'],
    queryFn: () => fetcher<{ orders: Order[] }>('/api/orders?status=open'),
    refetchInterval: 3000,
  })

  const floorPlans = floorPlanData?.floorPlans ?? []
  const takeawayOrders = (openOrdersData?.orders ?? []).filter((o) => o.tableId === null)
  const selectedPlanId =
    activeFloorPlan ?? (floorPlans.length > 0 ? String(floorPlans[0].id) : null)
  const selectedPlan = floorPlans.find((fp) => String(fp.id) === selectedPlanId) ?? null

  return (
    <div className="rms-scroll h-full overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h2 className="text-xl font-bold">Select a table</h2>
            <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <span className="relative flex size-2.5">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex size-2.5 rounded-full bg-emerald-500" />
              </span>
              live
            </span>
          </div>
          <Button onClick={onTakeaway} size="lg" className="h-11">
            <Plus /> New Takeaway Order
          </Button>
        </div>

        {/* Floor plan tabs */}
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-10 w-64" />
            <Skeleton className="h-[420px] w-full rounded-xl" />
          </div>
        ) : floorPlans.length === 0 ? (
          <div className="flex min-h-[240px] flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed text-muted-foreground">
            <MapPin className="size-8 opacity-40" />
            <p className="text-sm">No tables yet — add some in Admin → Floor Plans.</p>
          </div>
        ) : (
          <>
            {floorPlans.length > 1 && (
              <Tabs value={selectedPlanId ?? undefined} onValueChange={setActiveFloorPlan}>
                <TabsList className="h-10 flex-wrap">
                  {floorPlans.map((fp) => (
                    <TabsTrigger key={fp.id} value={String(fp.id)} className="px-4">
                      {fp.name}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            )}

            {/* Canvas */}
            <div className="relative min-h-[420px] w-full rounded-xl border-2 border-dashed border-border bg-[radial-gradient(circle,#e7e2d8_1px,transparent_1px)] [background-size:22px_22px] sm:min-h-[480px]">
              {(selectedPlan?.tables ?? []).length === 0 ? (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
                  <MapPin className="size-8 opacity-40" />
                  <p className="text-sm">
                    No tables on this floor plan yet — add some in Admin → Floor Plans.
                  </p>
                </div>
              ) : (
                (selectedPlan?.tables ?? []).map((t) => (
                  <TableTile key={t.id} table={t} onSelect={onSelectTable} />
                ))
              )}
            </div>

            {/* Legend */}
            <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-full bg-emerald-500" /> {TABLE_STATUS_LABELS.free}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-full bg-amber-500" /> {TABLE_STATUS_LABELS.occupied}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-full bg-rose-500" /> {TABLE_STATUS_LABELS.reserved}
              </span>
            </div>
          </>
        )}

        {/* Open takeaway orders */}
        {takeawayOrders.length > 0 && (
          <div className="mt-2">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-muted-foreground">
              <ShoppingBag className="size-4" /> Open takeaway orders
            </h3>
            <div className="grid gap-2 sm:grid-cols-2">
              {takeawayOrders.map((o) => (
                <div
                  key={o.id}
                  className="flex items-center justify-between gap-3 rounded-xl border bg-card p-3 shadow-sm"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">Takeaway #{o.id}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {o.items?.length ?? 0} item(s) — {formatCurrency(o.remainingAmount)} remaining
                    </p>
                  </div>
                  <Button variant="secondary" className="h-10 shrink-0" onClick={() => onOpenTakeawayOrder(o)}>
                    Open
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function TableTile({ table, onSelect }: { table: RestaurantTable; onSelect: (t: RestaurantTable) => void }) {
  const common =
    'absolute -translate-x-1/2 -translate-y-1/2 w-24 h-20 rounded-xl border-2 flex flex-col items-center justify-center gap-0.5 shadow-sm transition-transform font-semibold active:scale-95 hover:scale-105 p-1 text-center'

  const status = table.status
  if (status === 'occupied') {
    return (
      <button
        type="button"
        onClick={() => onSelect(table)}
        style={{ left: `${table.positionX}%`, top: `${table.positionY}%` }}
        className={cn(common, 'border-amber-400 bg-amber-100 text-amber-950')}
      >
        <span className="text-sm leading-tight">{table.name}</span>
        <span className="text-xs font-bold leading-tight">
          {formatCurrency(table.openOrderTotal ?? 0)}
        </span>
        <span className="text-[11px] leading-tight font-normal text-amber-700">
          {table.openOrderSince ? elapsedSince(table.openOrderSince) : 'open'}
        </span>
      </button>
    )
  }

  if (status === 'reserved') {
    return (
      <button
        type="button"
        onClick={() => onSelect(table)}
        style={{ left: `${table.positionX}%`, top: `${table.positionY}%` }}
        className={cn(common, 'border-rose-400 bg-rose-50 text-rose-900')}
      >
        <Clock className="size-4 text-rose-400" aria-hidden />
        <span className="text-sm leading-tight">{table.name}</span>
        <span className="text-[11px] leading-tight font-normal text-rose-500">
          {table.capacity} seats
        </span>
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(table)}
      style={{ left: `${table.positionX}%`, top: `${table.positionY}%` }}
      className={cn(common, 'border-emerald-400 bg-emerald-50 text-emerald-900')}
    >
      <Utensils className="size-4 text-emerald-400" aria-hidden />
      <span className="text-sm leading-tight">{table.name}</span>
      <span className="text-[11px] leading-tight font-normal text-emerald-600">
        seats {table.capacity}
      </span>
    </button>
  )
}
