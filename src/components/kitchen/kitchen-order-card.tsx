'use client'

import { Check, CheckCircle2, Loader2, Play, StickyNote } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { type Course, type ItemStatus, prepStationOf } from '@/lib/constants'
import { elapsedMinutes, elapsedSince, formatCurrency, formatQty, formatTime } from '@/lib/format'
import { localizedName, useI18n } from '@/lib/i18n'
import type { Order } from '@/lib/types'
import { cn } from '@/lib/utils'

export type CourseFilter = 'all' | Course

/** R11: station routing filter — 'all' or a station slug (kitchen/bar/
 *  shisha/custom). Mirrors CourseFilter: non-matching items dim in place. */
export type StationFilter = 'all' | string

/** i18n keys for the preset stations; custom slugs display as-is. */
export const STATION_LABEL_KEYS: Record<string, string> = {
  kitchen: 'kds.stationKitchen',
  bar: 'kds.stationBar',
  shisha: 'kds.stationShisha',
}

/** Active pill tint per station (kitchen-view filter row) — amber bar,
 *  violet shisha, emerald kitchen, sky custom. */
export const STATION_PILL_ACTIVE_CLASSES: Record<string, string> = {
  kitchen: 'border-emerald-500 bg-emerald-500 text-zinc-950',
  bar: 'border-amber-500 bg-amber-500 text-zinc-950',
  shisha: 'border-violet-400 bg-violet-400 text-zinc-950',
}

/** Small badge tint per station on the item lines (dark KDS cards). */
const STATION_BADGE_CLASSES: Record<string, string> = {
  kitchen: 'border-zinc-700 bg-zinc-800 text-zinc-400',
  bar: 'border-amber-500/40 bg-amber-500/15 text-amber-300',
  shisha: 'border-violet-500/40 bg-violet-500/15 text-violet-300',
}

/** Station display label: preset stations localize, custom slugs stay raw. */
export function stationLabel(station: string, t: (key: string) => string): string {
  const key = STATION_LABEL_KEYS[station]
  return key ? t(key) : station
}

/** R11: tiny routing badge on each item line (kitchen subtle, bar amber,
 *  shisha violet, custom sky) so cooks see routing at a glance. */
function StationBadge({ station, t }: { station: string; t: (key: string) => string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center rounded-full border px-1.5 py-0 text-[9px] font-bold uppercase tracking-wide',
        STATION_BADGE_CLASSES[station] ?? 'border-sky-500/40 bg-sky-500/15 text-sky-300',
      )}
      title={stationLabel(station, t)}
    >
      {stationLabel(station, t)}
    </span>
  )
}

const STATUS_CHIP_CLASSES: Record<string, string> = {
  new: 'border-rose-500/30 bg-rose-500/15 text-rose-400',
  preparing: 'border-amber-500/30 bg-amber-500/15 text-amber-400',
  ready: 'border-emerald-500/30 bg-emerald-500/15 text-emerald-400',
  served: 'border-zinc-700 bg-zinc-800 text-zinc-500',
}

const STATUS_CHIP_LABEL_KEYS: Record<string, string> = {
  new: 'status.item.new',
  preparing: 'status.item.preparing',
  ready: 'status.item.ready',
  served: 'status.item.served',
}

const NEXT_STATUS: Record<string, { labelKey: string; status: ItemStatus }> = {
  new: { labelKey: 'kds.start', status: 'preparing' },
  preparing: { labelKey: 'status.item.ready', status: 'ready' },
  ready: { labelKey: 'status.item.served', status: 'served' },
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
  /** R11: station routing filter — dims non-matching items like courseFilter. */
  stationFilter: StationFilter
  pendingItemId: number | null
  onUpdateItemStatus: (itemId: number, status: ItemStatus) => void
}

export function KitchenOrderCard({
  order,
  tick,
  courseFilter,
  stationFilter,
  pendingItemId,
  onUpdateItemStatus,
}: KitchenOrderCardProps) {
  const { t, lang } = useI18n()
  const minutes = elapsedMinutes(order.createdAt)
  const items = order.items
  const completed = items.length > 0 && items.every((item) => item.status === 'served')
  const readyCount = items.filter((item) => item.status === 'ready' || item.status === 'served').length
  const tableName =
    order.table?.name ??
    (order.tableId
      ? `${t('common.table')} #${order.tableId}`
      : order.orderType === 'delivery'
        ? t('kds.deliveryName', { phone: order.deliveryPhone ?? '' })
        : t('common.takeaway'))

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
            {t('common.order')} #{order.id} · {formatTime(order.createdAt)}
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
          // R11: station routing — items outside the active station dim too
          const station = prepStationOf(item.product?.category?.prepDestination)
          const stationDimmed = stationFilter !== 'all' && station !== stationFilter
          const next = NEXT_STATUS[item.status]
          const pending = pendingItemId === item.id
          return (
            <li
              key={item.id}
              className={cn(
                'flex items-center justify-between gap-2 rounded-lg px-1 py-0.5',
                (dimmed || stationDimmed) && 'opacity-30',
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
                  {t(STATUS_CHIP_LABEL_KEYS[item.status] ?? 'status.item.served')}
                </span>
                {/* R11: prep-station routing badge (Kitchen/Bar/Shisha/…) */}
                <StationBadge station={station} t={t} />
                <span className="truncate text-sm font-medium text-zinc-100">
                  {formatQty(item.quantity)} ×{' '}
                  {item.product
                    ? localizedName(item.product.name, item.product.nameAr, lang)
                    : t('kds.item')}
                </span>
                {/* R8: selected options — bold amber so the line sees them fast */}
                {item.selectedModifiers?.length ? (
                  <span
                    className="min-w-0 max-w-full truncate text-xs font-semibold text-amber-300"
                    title={item.selectedModifiers
                      .map((m) => localizedName(m.name, m.nameAr, lang))
                      .join(', ')}
                  >
                    •{' '}
                    {item.selectedModifiers
                      .map((m) => localizedName(m.name, m.nameAr, lang))
                      .join(', ')}
                  </span>
                ) : null}
                {/* R8: allergen warning chips — the product sub-object may
                    carry `allergens` via ORDER_INCLUDE (raw JSON column or a
                    parsed array); a local cast + parse keeps the shared
                    OrderItem type untouched. */}
                {(() => {
                  const rawAllergens =
                    (item.product as { allergens?: string[] | string | null } | null)
                      ?.allergens ?? []
                  let allergens: string[] = []
                  if (Array.isArray(rawAllergens)) allergens = rawAllergens
                  else {
                    try {
                      const parsed: unknown = JSON.parse(rawAllergens)
                      if (Array.isArray(parsed)) allergens = parsed.map(String)
                    } catch {
                      // invalid JSON — no badges
                    }
                  }
                  if (allergens.length === 0) return null
                  return (
                    <span
                      className="flex min-w-0 flex-wrap items-center gap-1"
                      title={`${t('kds.allergens')}: ${allergens
                        .map((a) => t(`allergen.${a}`))
                        .join(', ')}`}
                    >
                      {allergens.map((a) => (
                        <span
                          key={`al-${a}`}
                          className="rounded border border-rose-500/40 bg-rose-500/15 px-1 py-0 text-[10px] font-semibold leading-4 text-rose-300"
                        >
                          {t(`allergen.${a}`)}
                        </span>
                      ))}
                    </span>
                  )
                })()}
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
                  {t(`course.${item.course}`)}
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
                  {t(next.labelKey)}
                </Button>
              ) : null}
            </li>
          )
        })}
      </ul>

      {/* Progress footer */}
      <div className="flex items-center justify-between gap-2 border-t border-zinc-800 pt-2">
        <p className="text-xs text-zinc-500">
          {t('kds.itemsReady', { ready: readyCount, total: items.length })} ·{' '}
          {formatCurrency(order.totalAmount)}
        </p>
        {completed && (
          <Badge variant="outline" className="border-zinc-700 bg-zinc-800 text-zinc-400">
            {t('kds.completed')}
          </Badge>
        )}
      </div>
    </article>
  )
}
