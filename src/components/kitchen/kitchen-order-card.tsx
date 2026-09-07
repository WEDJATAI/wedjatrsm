'use client'

import { Check, CheckCircle2, Loader2, Play, StickyNote } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { COURSE_LABELS, type Course, type ItemStatus } from '@/lib/constants'
import { elapsedMinutes, elapsedSince, formatCurrency, formatQty, formatTime } from '@/lib/format'
import type { Order } from '@/lib/types'
import { cn } from '@/lib/utils'

export type CourseFilter = 'all' | Course

const STATUS_CHIP_CLASSES: Record<string, string> = {
  new: 'border-rose-500/30 bg-rose-500/15 text-rose-400',
  preparing: 'border-amber-500/30 bg-amber-500/15 text-amber-400',
  ready: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-400',
  served: 'border-zinc-700 bg-zinc-800 text-zinc-500',
}

const STATUS_CHIP_LABELS: Record<string, string> = {
  new: 'New',
  preparing: 'Prep',
  ready: 'Ready',
  served: 'Served',
}

const NEXT_STATUS: Record<string, { label: string; status: ItemStatus }> = {
  new: { label: 'Start', status: 'preparing' },
  preparing: { label: 'Ready', status: 'ready' },
  ready: { label: 'Served', status: 'served' },
}

/** Card border urgency: < 10m calm, 10-20m warning, > 20m critical. */
function urgencyBorder(minutes: number): string {
  if (minutes > 20) return 'border-rose-500/70'
  if (minutes >= 10) return 'border-amber-500/60'
  return 'border-zinc-800'
}

function urgencyText(minutes: number): string {
  if (minutes >= 20) return 'text-rose-400'
  if (minutes >= 10) return 'text-amber-400'
  return 'text-emerald-400'
}

type KitchenOrderCardProps = {
  order: Order
  /** Parent counter that increments every 5s so elapsed timers re-render. */
  tick: number
  courseFilter: CourseFilter
  pendingItemId: number | null
  onUpdateItemStatus: (itemId: number, status: ItemStatus) => void
}

export function KitchenOrderCard({
  order,
  tick,
  courseFilter,
  pendingItemId,
  onUpdateItemStatus,
}: KitchenOrderCardProps) {
  const minutes = elapsedMinutes(order.createdAt)
  const items = order.items
  const completed = items.length > 0 && items.every((item) => item.status === 'served')
  const readyCount = items.filter((item) => item.status === 'ready' || item.status === 'served').length
  const tableName = order.table?.name ?? (order.tableId ? `Table #${order.tableId}` : 'Takeaway')

  return (
    <article
      data-tick={tick}
      className={cn(
        'flex flex-col gap-3 rounded-xl border bg-zinc-900 p-4',
        urgencyBorder(minutes),
        completed && 'opacity-50',
      )}
    >
      {/* Table + order meta + elapsed timer */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-bold leading-tight">{tableName}</h2>
          <p className="text-sm text-zinc-500">
            Order #{order.id} · {formatTime(order.createdAt)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {minutes > 20 && <span className="size-2 animate-pulse rounded-full bg-rose-500" />}
          <span className={cn('font-mono text-lg font-bold tabular-nums', urgencyText(minutes))}>
            {elapsedSince(order.createdAt)}
          </span>
        </div>
      </div>

      {/* Items */}
      <ul className="space-y-1.5">
        {items.map((item) => {
          const dimmed = courseFilter !== 'all' && item.course !== courseFilter
          const next = NEXT_STATUS[item.status]
          const pending = pendingItemId === item.id
          return (
            <li
              key={item.id}
              className={cn(
                'flex items-center justify-between gap-2 rounded-lg px-1 py-0.5',
                dimmed && 'opacity-30',
                item.status === 'served' && 'opacity-40',
              )}
            >
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                <span
                  className={cn(
                    'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                    STATUS_CHIP_CLASSES[item.status] ?? 'border-zinc-700 bg-zinc-800 text-zinc-500',
                  )}
                >
                  {STATUS_CHIP_LABELS[item.status] ?? item.status}
                </span>
                <span className="truncate text-sm font-medium text-zinc-100">
                  {formatQty(item.quantity)} × {item.product?.name ?? 'Item'}
                </span>
                {item.notes ? (
                  <span
                    className="flex min-w-0 items-center gap-1 text-amber-300/90"
                    title={item.notes}
                  >
                    <StickyNote className="size-3.5 shrink-0" />
                    <span className="max-w-40 truncate italic text-xs">{item.notes}</span>
                  </span>
                ) : null}
                <span className="text-[10px] uppercase tracking-wide text-zinc-500">
                  {COURSE_LABELS[item.course] ?? item.course}
                </span>
              </div>

              {next ? (
                <Button
                  type="button"
                  disabled={pending}
                  onClick={() => onUpdateItemStatus(item.id, next.status)}
                  className={cn(
                    'h-9 min-w-24 shrink-0 font-semibold',
                    item.status === 'new' &&
                      'border border-amber-500 bg-amber-500 text-zinc-950 hover:bg-amber-400',
                    item.status === 'preparing' &&
                      'border border-emerald-500 bg-emerald-500 text-zinc-950 hover:bg-emerald-400',
                    item.status === 'ready' &&
                      'border border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100',
                  )}
                >
                  {pending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : item.status === 'new' ? (
                    <Play className="size-4" />
                  ) : item.status === 'preparing' ? (
                    <CheckCircle2 className="size-4" />
                  ) : (
                    <Check className="size-4" />
                  )}
                  {next.label}
                </Button>
              ) : null}
            </li>
          )
        })}
      </ul>

      {/* Progress footer */}
      <div className="flex items-center justify-between gap-2 border-t border-zinc-800 pt-2">
        <p className="text-xs text-zinc-500">
          {readyCount}/{items.length} items ready · {formatCurrency(order.totalAmount)}
        </p>
        {completed && (
          <Badge variant="outline" className="border-zinc-700 bg-zinc-800 text-zinc-400">
            Completed
          </Badge>
        )}
      </div>
    </article>
  )
}
