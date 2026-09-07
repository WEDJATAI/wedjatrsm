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
import { useI18n } from '@/lib/i18n'
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

/** Per-shape tile silhouette classes — Odoo 17-style tiles. The floor grid
 *  keeps its responsive layout (tiles fill the grid cell width); only the
 *  silhouette changes (square/round/rectangle/oval). The admin floor-plan
 *  editor mirrors these exact strings. */
const SHAPE_TILE_CLASSES: Record<string, string> = {
  square: 'aspect-square rounded-2xl',
  round: 'aspect-square rounded-full',
  rectangle: 'h-24 rounded-2xl',
  oval: 'h-24 rounded-full',
}

function shapeClasses(shape: string): string {
  return SHAPE_TILE_CLASSES[shape] ?? SHAPE_TILE_CLASSES.square
}

export default function TableSelect({
  onSelectTable,
  onTakeaway,
  onOpenTakeawayOrder,
  transferOrderId,
  onTransferDone,
}: TableSelectProps) {
  const queryClient = useQueryClient()
  const { t } = useI18n()

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
  const sourceLabel = source ? sourceOrder?.table?.name ?? t('common.takeaway') : null

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
      toast.success(t('pos.transferToast', { order: vars.orderId, table: vars.tableName }))
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
      toast.success(t('pos.mergeToast', { table: vars.targetLabel }))
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

  const tableInteraction = (t2: RestaurantTable): TableInteraction => {
    if (!tool || busy) return busy ? 'ineligible' : 'normal'
    if (tool === 'transfer') {
      if (source == null) return t2.openOrderId != null ? 'eligible' : 'ineligible'
      // Destination: free/reserved tables with no open order.
      return t2.openOrderId == null && t2.status !== 'occupied' ? 'eligible' : 'ineligible'
    }
    // Merge: source = any occupied table; target = another open order's table.
    if (source == null) return t2.openOrderId != null ? 'eligible' : 'ineligible'
    return t2.openOrderId != null && t2.openOrderId !== source.orderId ? 'eligible' : 'ineligible'
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

  const handleTableClick = (t2: RestaurantTable) => {
    if (busy) return
    if (tool === 'transfer') {
      if (source == null) {
        if (t2.openOrderId == null) return
        setSource({ orderId: t2.openOrderId })
        return
      }
      if (t2.openOrderId != null || t2.status === 'occupied') return
      transferMutation.mutate({ orderId: source.orderId, tableId: t2.id, tableName: t2.name })
      return
    }
    if (tool === 'merge') {
      if (source == null) {
        if (t2.openOrderId == null) return
        setSource({ orderId: t2.openOrderId })
        return
      }
      if (t2.openOrderId == null || t2.openOrderId === source.orderId) return
      mergeMutation.mutate({ sourceId: source.orderId, targetId: t2.openOrderId, targetLabel: t2.name })
      return
    }
    onSelectTable(t2)
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
        mergeMutation.mutate({
          sourceId: source.orderId,
          targetId: o.id,
          targetLabel: t('common.takeaway'),
        })
      }
      return
    }
    onOpenTakeawayOrder(o)
  }

  // ── Banner text ──────────────────────────────────────────────────
  const bannerText = busy
    ? tool === 'transfer'
      ? t('pos.transferring')
      : t('pos.merging')
    : tool === 'transfer'
      ? source
        ? sourceLabel
          ? t('pos.transferDest', { order: source.orderId, label: sourceLabel })
          : t('pos.transferDestNoLabel', { order: source.orderId })
        : t('pos.transferPick')
      : source
        ? t('pos.mergeTarget', {
            source: sourceLabel ?? `#${source.orderId}`,
          })
        : t('pos.mergePick')

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
              aria-label={t('pos.prevFloor')}
            >
              <ChevronLeft className="size-5 rtl:rotate-180" />
            </Button>
            <span className="min-w-[110px] text-center text-lg font-bold">
              {plan?.name ?? t('pos.floors')}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="h-11 w-11 rounded-xl"
              disabled={idx >= floorPlans.length - 1}
              onClick={() => setFloorIdx(idx + 1)}
              aria-label={t('pos.nextFloor')}
            >
              <ChevronRight className="size-5 rtl:rotate-180" />
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
              <span className="hidden sm:inline">{t('pos.transfer')}</span>
            </Button>
            <Button
              variant="outline"
              className="h-11 rounded-xl"
              disabled={openOrders.length < 2 || !!tool}
              onClick={startMergeTool}
            >
              <Combine className="text-[#714B67]" />
              <span className="hidden sm:inline">{t('pos.merge')}</span>
            </Button>
            <Button
              className="h-11 rounded-xl bg-[#714B67] text-white hover:bg-[#714B67]/90"
              disabled={!!tool}
              onClick={onTakeaway}
            >
              <Plus /> {t('pos.newTakeaway')}
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
              aria-label={t('pos.cancelTool')}
              title={t('common.cancel')}
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
                <Skeleton key={i} className="aspect-square rounded-2xl" />
              ))}
            </div>
          ) : floorPlans.length === 0 ? (
            <div className="flex min-h-[280px] flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-[#E2E2E0] text-muted-foreground">
              <MapPin className="size-8 opacity-40" />
              <p className="text-sm">{t('pos.noTables')}</p>
            </div>
          ) : tables.length === 0 ? (
            <div className="flex min-h-[280px] flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-[#E2E2E0] text-muted-foreground">
              <MapPin className="size-8 opacity-40" />
              <p className="text-sm">{t('pos.noTablesFloor')}</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
              {tables.map((t2) => (
                <TableTile
                  key={t2.id}
                  table={t2}
                  interaction={tableInteraction(t2)}
                  onClick={() => handleTableClick(t2)}
                />
              ))}
            </div>
          )}

          {/* ── Open takeaway orders ── */}
          {takeawayOrders.length > 0 && (
            <section className="mt-6">
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-stone-500">
                <ShoppingBag className="size-4" /> {t('pos.openTakeaways')}
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
  const { t } = useI18n()
  const occupied = table.status === 'occupied' || table.openOrderId != null
  const reserved = table.status === 'reserved' && table.openOrderId == null
  // Round/oval silhouettes get extra horizontal padding so the centered
  // content stays inside the circle (overflow-hidden + truncation clip it).
  const isRound = table.shape === 'round' || table.shape === 'oval'

  // Odoo duration "heat": occupied tables tint by how long guests are seated.
  const mins =
    occupied && table.openOrderSince
      ? Math.max(0, (Date.now() - new Date(table.openOrderSince).getTime()) / 60000)
      : 0

  const heat = occupied
    ? mins < 15
      ? {
          tile: 'border-emerald-200 bg-emerald-50',
          text: 'text-emerald-900',
          amount: 'text-emerald-700',
          meta: 'text-emerald-600',
        }
      : mins < 45
        ? {
            tile: 'border-amber-200 bg-amber-50',
            text: 'text-amber-900',
            amount: 'text-amber-700',
            meta: 'text-amber-600',
          }
        : mins < 90
          ? {
              tile: 'border-orange-300 bg-orange-100',
              text: 'text-orange-900',
              amount: 'text-orange-700',
              meta: 'text-orange-600',
            }
          : {
              tile: 'border-rose-300 bg-rose-100',
              text: 'text-rose-900',
              amount: 'text-rose-700',
              meta: 'text-rose-600',
            }
    : null

  return (
    <button
      type="button"
      disabled={interaction === 'ineligible'}
      onClick={onClick}
      className={cn(
        'relative flex min-w-0 flex-col items-center justify-center gap-1 overflow-hidden border p-3 text-center shadow-sm transition hover:shadow-md active:scale-[0.97]',
        shapeClasses(table.shape),
        isRound && 'px-4',
        occupied && heat
          ? cn(heat.tile, heat.text)
          : reserved
            ? 'border-amber-300 bg-amber-50/70 text-amber-900 ring-1 ring-amber-400'
            : 'border-[#E2E2E0] bg-white text-stone-500',
        interaction === 'ineligible' && 'cursor-not-allowed opacity-40',
        interaction === 'eligible' && 'ring-2 ring-[#714B67] ring-offset-1',
      )}
    >
      {/* FREE — clean white tile with capacity */}
      {!occupied && !reserved && (
        <>
          <p className="max-w-full truncate text-base font-bold leading-tight text-stone-500">
            {table.name}
          </p>
          <p className="flex items-center gap-1 text-xs text-stone-400">
            <Users className="size-3.5" aria-hidden />
            {table.capacity} {t('common.seats')}
          </p>
        </>
      )}

      {/* OCCUPIED — duration "heat" tint, amount + guests + elapsed */}
      {occupied && (
        <>
          <p className="max-w-full truncate text-base font-bold leading-tight">{table.name}</p>
          <p className={cn('text-lg font-extrabold tabular-nums leading-none', heat?.amount)}>
            {formatCurrency(table.openOrderTotal ?? 0)}
          </p>
          <p className={cn('flex items-center justify-center gap-1.5 text-[11px]', heat?.meta)}>
            <Users className="size-3.5" aria-hidden />
            {table.openOrderGuests ?? '—'}
            <span aria-hidden>·</span>
            <Clock className="size-3" aria-hidden />
            {table.openOrderSince ? elapsedSince(table.openOrderSince) : t('pos.open')}
          </p>
        </>
      )}

      {/* RESERVED — amber outline ring + badge */}
      {reserved && (
        <>
          <p className="max-w-full truncate text-base font-bold leading-tight">{table.name}</p>
          <p className="flex items-center gap-1 text-xs text-amber-600">
            <Users className="size-3.5" aria-hidden />
            {table.capacity} {t('common.seats')}
          </p>
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/60 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-600">
            <Clock className="size-3" aria-hidden />
            {t('status.table.reserved')}
          </span>
        </>
      )}
    </button>
  )
}
