'use client'

// ─── Vision Analytics tab — observed dwell/turnover/occupancy ─────────
// Data provenance is explicit everywhere: "Observed" (stone) for direct
// camera measurements, "Estimated" (amber) for derived metrics, and
// "Human-confirmed" (emerald) for the movement funnel. Charts mirror the
// reports-view recharts patterns (same grid/tick styling, amber bars).

import { useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { BarChart3, CalendarRange } from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatCurrency, formatDate, formatTime } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import type { VisionAnalyticsDTO } from '@/lib/types'

import { ProvenanceChip, StatBlock, VisionErrorCard } from './vision-shared'
import { formatMinutes, formatPct } from './vision-utils'

const GRID_STROKE = '#e7e5e4'
const TICK_STYLE = { fontSize: 12, fill: '#78716c' }

type TooltipEntry = {
  name?: string | number
  value?: string | number
  payload?: Record<string, unknown>
}

function VisionChartTooltip({
  active,
  payload,
  label,
  suffix,
}: {
  active?: boolean
  payload?: TooltipEntry[]
  label?: string | number
  suffix?: string
}) {
  if (!active || !payload || payload.length === 0) return null
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
      {label != null && label !== '' ? <p className="mb-1 font-medium">{label}</p> : null}
      {payload.map((entry, i) => (
        <p key={i} className="text-muted-foreground">
          <span>{entry.name}: </span>
          <span className="font-medium text-foreground">
            {Number(entry.value ?? 0)}
            {suffix ?? ''}
          </span>
        </p>
      ))}
    </div>
  )
}

type Props = {
  analytics: VisionAnalyticsDTO | undefined
  isLoading: boolean
  isError: boolean
  refetch: () => void
  range: { from: string; to: string }
  onRangeChange: (range: { from: string; to: string }) => void
}

export default function VisionAnalyticsTab({
  analytics,
  isLoading,
  isError,
  refetch,
  range,
  onRangeChange,
}: Props) {
  const { t } = useI18n()
  const [draftFrom, setDraftFrom] = useState(range.from)
  const [draftTo, setDraftTo] = useState(range.to)

  const applyRange = () => {
    if (draftFrom === '' || draftTo === '') return
    if (new Date(draftFrom) > new Date(draftTo)) {
      toast.error(t('vision.analytics.rangeError'))
      return
    }
    onRangeChange({ from: draftFrom, to: draftTo })
  }

  if (isLoading) {
    return (
      <section className="space-y-4" aria-busy="true">
        <Skeleton className="h-11 w-full max-w-md rounded-2xl" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-72 w-full rounded-2xl" />
      </section>
    )
  }
  if (isError || !analytics) {
    return <VisionErrorCard onRetry={refetch} />
  }

  // occupancyByHour is always 24 slots (zeros when idle) — real presence is
  // guests/events; the movement funnel alone (stats > 0) also counts.
  const hasData =
    analytics.totalGuestsObserved > 0 ||
    analytics.eventStats.total > 0 ||
    analytics.movementStats.total > 0

  const occupancyData = analytics.occupancyByHour.map((d) => ({
    label: `${String(d.hour).padStart(2, '0')}:00`,
    occupiedPct: Math.round(d.occupiedPct),
    avgGuests: d.avgGuests,
  }))

  const ms = analytics.movementStats
  const confirmRatePct =
    ms.confirmRate != null ? Math.round(Math.min(1, Math.max(0, ms.confirmRate)) * 100) : null

  return (
    <section className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('vision.analytics.subtitle')}</p>

      {/* ── date range ── */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="space-y-1">
            <Label htmlFor="va-from" className="text-xs">
              {t('vision.analytics.from')}
            </Label>
            <Input
              id="va-from"
              type="date"
              className="h-11"
              value={draftFrom}
              max={draftTo}
              onChange={(e) => setDraftFrom(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="va-to" className="text-xs">
              {t('vision.analytics.to')}
            </Label>
            <Input
              id="va-to"
              type="date"
              className="h-11"
              value={draftTo}
              min={draftFrom}
              onChange={(e) => setDraftTo(e.target.value)}
            />
          </div>
          <Button variant="outline" className="h-11 gap-1.5" onClick={applyRange}>
            <CalendarRange className="size-4" aria-hidden />
            {t('common.apply')}
          </Button>
          <p className="ms-auto text-xs text-muted-foreground tabular-nums">
            {t('admin.showingRange', {
              from: formatDate(analytics.from),
              to: formatDate(analytics.to),
            })}
          </p>
        </CardContent>
      </Card>

      {!hasData ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-2 p-8 text-center">
            <BarChart3 className="size-8 text-muted-foreground/40" aria-hidden />
            <p className="text-sm text-muted-foreground">{t('vision.analytics.noData')}</p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* ── KPI cards (provenance-labelled) ── */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatBlock
              label={t('vision.analytics.avgDwell')}
              value={formatMinutes(analytics.avgDwellMinutes)}
              chip={<ProvenanceChip kind="observed" />}
            />
            <StatBlock
              label={t('vision.analytics.avgTurnover')}
              value={formatMinutes(analytics.avgTurnoverMinutes)}
              chip={<ProvenanceChip kind="estimated" />}
            />
            <StatBlock
              label={t('vision.analytics.guestsObserved')}
              value={analytics.totalGuestsObserved}
              chip={<ProvenanceChip kind="observed" />}
            />
            <StatBlock
              label={t('vision.analytics.occupiedHours')}
              value={Math.round(analytics.occupiedTableHours * 10) / 10}
              chip={<ProvenanceChip kind="estimated" />}
            />
            <StatBlock
              label={t('vision.analytics.revenuePerHour')}
              value={formatCurrency(analytics.revenuePerOccupiedTableHour ?? 0)}
              chip={<ProvenanceChip kind="estimated" />}
            />
          </div>

          {/* ── occupancy by hour ── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('vision.analytics.occupancyByHour')}</CardTitle>
              <CardDescription>
                {t('vision.analytics.occupancyByHourDesc')} ·{' '}
                <Badge variant="outline" className="border-amber-400 bg-amber-50 text-[10px] text-amber-700">
                  {t('vision.analytics.observedEstimate')}
                </Badge>
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={occupancyData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={GRID_STROKE} />
                  <XAxis
                    dataKey="label"
                    tick={TICK_STYLE}
                    tickLine={false}
                    axisLine={{ stroke: GRID_STROKE }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tickFormatter={(v: number) => `${v}%`}
                    tick={TICK_STYLE}
                    tickLine={false}
                    axisLine={false}
                    width={48}
                    domain={[0, 100]}
                  />
                  <Tooltip
                    content={
                      <VisionChartTooltip suffix="%" />
                    }
                    cursor={{ fill: 'rgba(245, 158, 11, 0.08)' }}
                  />
                  <Bar
                    dataKey="occupiedPct"
                    name={t('vision.analytics.occupiedPct')}
                    fill="#f59e0b"
                    radius={[6, 6, 0, 0]}
                    maxBarSize={20}
                  />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {/* ── movement funnel (human-confirmed) ── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('vision.analytics.movementsTitle')}</CardTitle>
              <CardDescription>{t('vision.analytics.movementsDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
                <StatBlock label={t('vision.analytics.movementsTotal')} value={ms.total} />
                <StatBlock label={t('vision.movements.status.confirmed')} value={ms.confirmed} />
                <StatBlock label={t('vision.movements.status.rejected')} value={ms.rejected} />
                <StatBlock label={t('vision.movements.status.pending')} value={ms.pending} />
                <StatBlock label={t('vision.analytics.movementsConflict')} value={ms.conflict} />
                <StatBlock label={t('vision.analytics.movementsExpired')} value={ms.expired} />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-card p-4">
                <div>
                  <p className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    {t('vision.analytics.confirmRate')}
                    <ProvenanceChip kind="humanConfirmed" />
                  </p>
                  <p className="mt-1 text-3xl font-extrabold tabular-nums">
                    {confirmRatePct != null ? `${confirmRatePct}%` : '—'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t('vision.analytics.ofTotal', { total: ms.total })}
                  </p>
                </div>
                {/* confirmed vs rejected two-segment bar */}
                <div className="w-full max-w-xs space-y-1.5">
                  <div className="flex h-3 w-full overflow-hidden rounded-full bg-stone-200" role="img" aria-label={t('vision.analytics.confirmRate')}>
                    <div
                      className="bg-emerald-500"
                      style={{ width: `${confirmRatePct ?? 0}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
                    <span className="font-semibold text-emerald-700">{ms.confirmed}</span>
                    <span className="font-semibold text-stone-500">{ms.rejected}</span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* ── event stats ── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('vision.analytics.eventsTitle')}</CardTitle>
              <CardDescription>{t('vision.analytics.eventsDesc')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                <StatBlock label={t('vision.analytics.eventsTotal')} value={analytics.eventStats.total} />
                <StatBlock
                  label={t('vision.analytics.eventsApplied')}
                  value={analytics.eventStats.applied}
                  chip={<ProvenanceChip kind="observed" />}
                />
                <StatBlock label={t('vision.analytics.eventsDuplicates')} value={analytics.eventStats.duplicates} />
                <StatBlock label={t('vision.analytics.eventsStale')} value={analytics.eventStats.stale} />
                <StatBlock
                  label={t('vision.analytics.eventsLowConfidence')}
                  value={analytics.eventStats.lowConfidence}
                />
              </div>
            </CardContent>
          </Card>

          {/* ── per-table dwell ── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('vision.analytics.perTableTitle')}</CardTitle>
              <CardDescription>
                {t('vision.analytics.perTableDesc')} · <ProvenanceChip kind="observed" />
              </CardDescription>
            </CardHeader>
            <CardContent>
              {analytics.perTable.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('vision.analytics.noData')}</p>
              ) : (
                <div className="rms-scroll max-h-96 overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('vision.analytics.table')}</TableHead>
                        <TableHead className="text-end">
                          {t('vision.analytics.periods')}
                        </TableHead>
                        <TableHead className="text-end">
                          {t('vision.analytics.totalDwell')}
                        </TableHead>
                        <TableHead className="text-end">
                          {t('vision.analytics.avgDwellCol')}
                        </TableHead>
                        <TableHead className="text-end">
                          {t('vision.analytics.turnovers')}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {analytics.perTable.map((row) => (
                        <TableRow key={row.tableId}>
                          <TableCell className="font-semibold">{row.name}</TableCell>
                          <TableCell className="text-end tabular-nums">
                            {row.occupiedPeriods}
                          </TableCell>
                          <TableCell className="text-end tabular-nums">
                            {formatMinutes(row.totalDwellMinutes)}
                          </TableCell>
                          <TableCell className="text-end tabular-nums">
                            {formatMinutes(row.avgDwellMinutes)}
                          </TableCell>
                          <TableCell className="text-end tabular-nums">
                            {row.turnoverCount}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* ── camera uptime ── */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t('vision.analytics.cameraUptimeTitle')}</CardTitle>
              <CardDescription>{t('vision.analytics.cameraUptimeDesc')}</CardDescription>
            </CardHeader>
            <CardContent>
              {analytics.cameraUptime.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('vision.analytics.noData')}</p>
              ) : (
                <div className="rms-scroll max-h-72 overflow-y-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('vision.analytics.camera')}</TableHead>
                        <TableHead className="text-end">
                          {t('vision.analytics.events')}
                        </TableHead>
                        <TableHead className="text-end">
                          {t('vision.analytics.onlinePct')}
                        </TableHead>
                        <TableHead className="text-end">
                          {t('vision.analytics.lastSeen')}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {analytics.cameraUptime.map((cam) => (
                        <TableRow key={cam.cameraCode}>
                          <TableCell className="font-mono text-xs font-bold uppercase">
                            {cam.cameraCode}
                          </TableCell>
                          <TableCell className="text-end tabular-nums">{cam.events}</TableCell>
                          <TableCell className="text-end tabular-nums">
                            {formatPct(cam.onlinePct)}
                          </TableCell>
                          <TableCell className="text-end tabular-nums">
                            {cam.lastSeenAt ? formatTime(cam.lastSeenAt) : '—'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </section>
  )
}
