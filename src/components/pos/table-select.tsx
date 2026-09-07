'use client'

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeftRight,
  ChevronLeft,
  ChevronRight,
  Clock,
  Combine,
  Loader2,
  MapPin,
  Plus,
  ShoppingBag,
  Users,
  X,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { apiFetch, fetcher } from '@/lib/api'
import { elapsedSince, formatCurrency } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { FloorPlan, Order, RestaurantTable } from '@/lib/types'

type TableSelectProps = {
  onSelectTable: (table: RestaurantTable) => void
  onTakeaway: () => void
  onOpenTakeawayOrder: (order: Order) => void
  /** When set, start directly in transfer step 2 (destination selection) for this order. */
  transferOrderId?: number | null
  /** Called after a transfer completes (pos-view resets its order screen state). */
  onTransferDone?: () => void
}

type ToolKind = 'transfer' | 'merge'
type SourcePick = { orderId: number }

type TableInteraction = 'normal' | 'eligible' | 'ineligible'

export default function TableSelect({
  onSelectTable,
  onTakeaway,
  onOpenTakeawayOrder,
  transferOrderId,
  onTransferDone,
}: TableSelectProps) {
  const queryClient = useQueryClient()

  const [floorIdx, setFloorIdx] = useState(0)
  // When pos-view passes transferOrderId (Transfer clicked on the order
  // screen), this component mounts fresh in transfer step 2 (destination
  // selection) — pos-view only sets it right before switching to tables view,
  // so mount-time initialization is sufficient.
  const [tool, setTool] = useState<ToolKind | null>(transferOrderId != null ? 'transfer' : null)
  const [source, setSource] = useState<SourcePick | null>(
    transferOrderId != null ? { orderId: transferOrderId } : null,
  )

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
  const openOrders = openOrdersData?.orders ?? []
  const takeawayOrders = useMemo(
    () => openOrders.filter((o) => o.tableId === null),
    [openOrders],
  )

  const idx = floorPlans.length > 0 ? Math.min(floorIdx, floorPlans.length - 1) : 0
  const plan = floorPlans[idx] ?? null

  const sourceOrder = source ? openOrders.find((o) => o.id === source.orderId) ?? null : null
  const sourceLabel = source ? sourceOrder?.table?.name ?? 'Takeaway' : null

  // ── Transfer & merge mutations ───────────────────────────────────
  const invalidateAfterMove = async (...orderIds: number[]) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['floorplans'] }),
      queryClient.invalidateQueries({ queryKey: ['orders'] }),
      queryClient.invalidateQueries({ queryKey: ['orders', 'open'] }),
      queryClient.invalidateQueries({ queryKey: ['tables-status'] }),
      ...orderIds.map((id) => queryClient.invalidateQueries({ queryKey: ['pos-order', id] })),
    ])
  }

  const transferMutation = useMutation({
    mutationFn: (vars: { orderId: number; tableId: number; tableName: string }) =>
      apiFetch<{ order: Order }>(`/api/orders/${vars.orderId}/transfer`, {
        method: 'POST',
        body: { tableId: vars.tableId },
      }),
    onSuccess: async (_data, vars) => {
      toast.success(`Order #${vars.orderId} transferred to ${vars.tableName}`)
      await invalidateAfterMove(vars.orderId)
      exitTool()
      onTransferDone?.()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const mergeMutation = useMutation({
    mutationFn: (vars: { sourceId: number; targetId: number; targetLabel: string }) =>
      apiFetch<{ order: Order }>(`/api/orders/${vars.targetId}/merge`, {
        method: 'POST',
        body: { sourceOrderId: vars.sourceId },
      }),
    onSuccess: async (_data, vars) => {
      toast.success(`Orders merged into ${vars.targetLabel}`)
      await invalidateAfterMove(vars.sourceId, vars.targetId)
      exitTool()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const busy = transferMutation.isPending || mergeMutation.isPending

  // ── Tool mode helpers ────────────────────────────────────────────
  const exitTool = () => {
    setTool(null)
    setSource(null)
  }

  const startTransferTool = () => {
    setTool('transfer')
    setSource(null)
  }

  const startMergeTool = () => {
    setTool('merge')
    setSource(null)
  }

  const tableInteraction = (t: RestaurantTable): TableInteraction => {
    if (!tool || busy) return busy ? 'ineligible' : 'normal'
    if (tool === 'transfer') {
      if (source == null) return t.openOrderId != null ? 'eligible' : 'ineligible'
      // Destination: free/reserved tables with no open order.
      return t.openOrderId == null && t.status !== 'occupied' ? 'eligible' : 'ineligible'
    }
    // Merge: source = any occupied table; target = another open order's table.
    if (source == null) return t.openOrderId != null ? 'eligible' : 'ineligible'
    return t.openOrderId != null && t.openOrderId !== source.orderId ? 'eligible' : 'ineligible'
  }

  const takeawayInteraction = (o: Order): TableInteraction => {
    if (!tool || busy) return busy ? 'ineligible' : 'normal'
    if (tool === 'transfer') {
      // Takeaway orders are valid transfer sources, never destinations.
      return source == null ? 'eligible' : 'ineligible'
    }
    if (source == null) return 'eligible'
    return o.id !== source.orderId ? 'eligible' : 'ineligible'
  }

  const handleTableClick = (t: RestaurantTable) => {
    if (busy) return
    if (tool === 'transfer') {
      if (source == null) {
        if (t.openOrderId == null) return
        setSource({ orderId: t.openOrderId })
        return
      }
      if (t.openOrderId != null || t.status === 'occupied') return
      transferMutation.mutate({ orderId: source.orderId, tableId: t.id, tableName: t.name })
      return
    }
    if (tool === 'merge') {
      if (source == null) {
        if (t.openOrderId == null) return
        setSource({ orderId: t.openOrderId })
        return
      }
      if (t.openOrderId == null || t.openOrderId === source.orderId) return
      mergeMutation.mutate({ sourceId: source.orderId, targetId: t.openOrderId, targetLabel: t.name })
      return
    }
    onSelectTable(t)
  }

  const handleTakeawayClick = (o: Order) => {
    if (busy) return
    if (tool === 'transfer') {
      if (source == null) setSource({ orderId: o.id })
      return
    }
    if (tool === 'merge') {
      if (source == null) {
        setSource({ orderId: o.id })
      } else if (o.id !== source.orderId) {
        mergeMutation.mutate({ sourceId: source.orderId, targetId: o.id, targetLabel: 'Takeaway' })
      }
      return
    }
    onOpenTakeawayOrder(o)
  }

  // ── Banner text ──────────────────────────────────────────────────
  const bannerText = busy
    ? tool === 'transfer'
      ? 'Transferring…'
      : 'Merging…'
    : tool === 'transfer'
      ? source
        ? `Select the destination table for order #${source.orderId}${sourceLabel ? ` (${sourceLabel})` : ''}`
        : 'Transfer — select the order to move'
      : source
        ? `Now select the table to merge INTO (from ${sourceLabel ?? `order #${source.orderId}`})`
        : 'Merge — select the source table'

  const tables = plan?.tables ?? []

  return (
    <div className="rms-scroll h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-6xl flex-col">
        {/* ── Control bar ── */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E2E2E0] bg-white px-4 py-3">
          {/* Floor switcher */}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              className="h-11 w-11 rounded-xl"
              disabled={idx <= 0}
              onClick={() => setFloorIdx(idx - 1)}
              aria-label="Previous floor"
            >
              <ChevronLeft className="size-5" />
            </Button>
            <span className="min-w-[110px] text-center text-lg font-bold">
              {plan?.name ?? 'Floors'}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="h-11 w-11 rounded-xl"
              disabled={idx >= floorPlans.length - 1}
              onClick={() => setFloorIdx(idx + 1)}
              aria-label="Next floor"
            >
              <ChevronRight className="size-5" />
            </Button>
          </div>

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              className="h-11 rounded-xl"
              disabled={openOrders.length === 0 || !!tool}
              onClick={startTransferTool}
            >
              <ArrowLeftRight className="text-[#714B67]" />
              <span className="hidden sm:inline">Transfer</span>
            </Button>
            <Button
              variant="outline"
              className="h-11 rounded-xl"
              disabled={openOrders.length < 2 || !!tool}
              onClick={startMergeTool}
            >
              <Combine className="text-[#714B67]" />
              <span className="hidden sm:inline">Merge</span>
            </Button>
            <Button
              className="h-11 rounded-xl bg-[#714B67] text-white hover:bg-[#714B67]/90"
              disabled={!!tool}
              onClick={onTakeaway}
            >
              <Plus /> New Takeaway Order
            </Button>
          </div>
        </div>

        {/* ── Transfer/merge banner ── */}
        {tool && (
          <div
            className="flex items-center gap-3 bg-[#714B67] px-4 py-3 text-white"
            role="status"
          >
            {busy ? (
              <Loader2 className="size-5 shrink-0 animate-spin" aria-hidden />
            ) : tool === 'transfer' ? (
              <ArrowLeftRight className="size-5 shrink-0" aria-hidden />
            ) : (
              <Combine className="size-5 shrink-0" aria-hidden />
            )}
            <p className="min-w-0 flex-1 text-sm font-semibold">{bannerText}</p>
            <Button
              variant="ghost"
              size="icon"
              className="size-11 shrink-0 rounded-full text-white hover:bg-white/20 hover:text-white"
              onClick={exitTool}
              disabled={busy}
              aria-label="Cancel transfer/merge"
              title="Cancel"
            >
              <X className="size-5" />
            </Button>
          </div>
        )}

        {/* ── Tables grid + takeaway ── */}
        <div className="p-4 sm:p-6">
          {isLoading ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-[110px] rounded-xl" />
              ))}
            </div>
          ) : floorPlans.length === 0 ? (
            <div className="flex min-h-[280px] flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-[#E2E2E0] text-muted-foreground">
              <MapPin className="size-8 opacity-40" />
              <p className="text-sm">No tables yet — add some in Admin → Floor Plans.</p>
            </div>
          ) : tables.length === 0 ? (
            <div className="flex min-h-[280px] flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-[#E2E2E0] text-muted-foreground">
              <MapPin className="size-8 opacity-40" />
              <p className="text-sm">No tables on this floor yet — add some in Admin → Floor Plans.</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
              {tables.map((t) => (
                <TableTile
                  key={t.id}
                  table={t}
                  interaction={tableInteraction(t)}
                  onClick={() => handleTableClick(t)}
                />
              ))}
            </div>
          )}

          {/* ── Open takeaway orders ── */}
          {takeawayOrders.length > 0 && (
            <section className="mt-6">
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-stone-500">
                <ShoppingBag className="size-4" /> Open takeaway orders
              </h3>
              <div className="rms-scroll flex gap-2 overflow-x-auto pb-2">
                {takeawayOrders.map((o) => {
                  const interaction = takeawayInteraction(o)
                  return (
                    <button
                      key={o.id}
                      type="button"
                      disabled={interaction === 'ineligible'}
                      onClick={() => handleTakeawayClick(o)}
                      className={cn(
                        'flex h-11 shrink-0 items-center gap-2 rounded-full border border-[#E2E2E0] bg-white px-4 shadow-sm transition active:scale-95',
                        interaction === 'ineligible' && 'cursor-not-allowed opacity-40',
                        interaction === 'eligible' && 'ring-2 ring-[#714B67] ring-offset-1',
                      )}
                    >
                      <ShoppingBag className="size-4 text-[#714B67]" aria-hidden />
                      <span className="text-sm font-semibold">#{o.id}</span>
                      <span className="text-sm font-bold tabular-nums text-[#714B67]">
                        {formatCurrency(o.remainingAmount)}
                      </span>
                      <span className="text-xs text-stone-500">{elapsedSince(o.createdAt)}</span>
                    </button>
                  )
                })}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}

function TableTile({
  table,
  interaction,
  onClick,
}: {
  table: RestaurantTable
  interaction: TableInteraction
  onClick: () => void
}) {
  const occupied = table.status === 'occupied' || table.openOrderId != null
  const reserved = table.status === 'reserved' && table.openOrderId == null

  return (
    <button
      type="button"
      disabled={interaction === 'ineligible'}
      onClick={onClick}
      className={cn(
        'relative flex min-h-[110px] min-w-0 flex-col justify-between overflow-hidden rounded-xl border border-[#E2E2E0] bg-white p-3 text-left shadow-sm transition active:scale-[0.98]',
        interaction === 'ineligible' && 'cursor-not-allowed opacity-40',
        interaction === 'eligible' && 'ring-2 ring-[#714B67] ring-offset-1',
        interaction === 'normal' && reserved && 'ring-1 ring-amber-500',
      )}
    >
      {occupied && (
        <span className="absolute inset-y-0 left-0 w-1.5 rounded-l-xl bg-[#714B67]" aria-hidden />
      )}

      <div className="min-w-0 pl-1.5">
        <p
          className={cn(
            'truncate text-base font-bold leading-tight',
            !occupied && !reserved && 'text-stone-500',
          )}
        >
          {table.name}
        </p>
        <p className="mt-0.5 flex items-center gap-1 text-xs text-stone-500">
          <Users className="size-3.5" aria-hidden />
          {table.capacity} seats
        </p>
      </div>

      {occupied && (
        <div className="pl-1.5">
          <p className="text-lg font-bold leading-tight tabular-nums text-[#714B67]">
            {formatCurrency(table.openOrderTotal ?? 0)}
          </p>
          <p className="text-[11px] text-stone-500">
            {table.openOrderSince ? elapsedSince(table.openOrderSince) : 'open'}
          </p>
        </div>
      )}

      {reserved && (
        <span className="ml-1.5 inline-flex w-fit items-center gap-1.5 rounded-full border border-amber-500/60 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-600">
          <Clock className="size-3" aria-hidden />
          Reserved
        </span>
      )}
    </button>
  )
}
