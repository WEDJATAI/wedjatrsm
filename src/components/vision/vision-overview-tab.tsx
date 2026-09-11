'use client'

// ─── Vision Overview tab — KPIs + LIVE observed floor + alerts ───────
// The centerpiece: floor tiles tinted by the OBSERVED (AI) state with
// mismatch rings vs POS, people counts, dwell heat, pending-move chips
// and the manual override dialog. Observation never writes POS state —
// only the human override / movement confirmation flows do.

import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import {
  CheckCircle2,
  Clock,
  Cctv,
  Hand,
  Loader2,
  PersonStanding,
  TriangleAlert,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { apiFetch, fetcher } from '@/lib/api'
import { elapsedSince } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import type {
  MovementCandidateDTO,
  VisionFloorTableDTO,
  VisionOverviewDTO,
} from '@/lib/types'
import { cn } from '@/lib/utils'

import MovementQuickDialog from './movement-quick-dialog'
import { VisionAlertRow, VisionErrorCard, VisionSkeletonGrid } from './vision-shared'
import type { VisionTab } from './vision-view'
import {
  formatMinutes,
  isManualHoldActive,
  shapeClasses,
  visionHeat,
} from './vision-utils'

type Props = {
  overviewQuery: UseQueryResult<{ overview: VisionOverviewDTO }, Error>
  onTab: (tab: VisionTab) => void
}

export default function VisionOverviewTab({ overviewQuery, onTab }: Props) {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const [floorIdx, setFloorIdx] = useState(0)
  const [overrideTarget, setOverrideTarget] = useState<VisionFloorTableDTO | null>(null)
  const [overridePeople, setOverridePeople] = useState('')
  const [overrideReason, setOverrideReason] = useState('')
  const [quickMovement, setQuickMovement] = useState<MovementCandidateDTO | null>(null)

  // Pending suggestions drive the amber chips on from-table tiles.
  const pendingQuery = useQuery({
    queryKey: ['vision-movements', 'pending'],
    queryFn: () => fetcher<{ movements: MovementCandidateDTO[] }>('/api/vision/movements?status=pending'),
    refetchInterval: 8_000,
  })
  const pendingMovements = pendingQuery.data?.movements ?? []

  // Manual human override — freezes AI display state for a hold window.
  const overrideMutation = useMutation({
    mutationFn: (vars: {
      id: number
      name: string
      state: 'occupied' | 'empty'
      peopleCount?: number
      reason?: string
    }) =>
      apiFetch<{ state: string }>(`/api/vision/tables/${vars.id}/override`, {
        body: {
          state: vars.state,
          peopleCount: vars.peopleCount,
          reason: vars.reason,
        },
      }),
    onSuccess: async (_data, vars) => {
      toast.success(
        t('vision.override.applied', {
          table: vars.name,
          state: vars.state === 'occupied' ? t('vision.state.occupied') : t('vision.state.empty'),
        }),
      )
      setOverrideTarget(null)
      setOverridePeople('')
      setOverrideReason('')
      await queryClient.invalidateQueries({ queryKey: ['vision-overview'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const overview = overviewQuery.data?.overview
  const kpis = overview?.kpis
  const floors = overview?.floors ?? []
  const mismatchCount = useMemo(
    () =>
      floors.reduce(
        (sum, f) => sum + f.tables.filter((tb) => tb.mismatch !== 'none').length,
        0,
      ),
    [floors],
  )

  const idx = floors.length > 0 ? Math.min(floorIdx, floors.length - 1) : 0
  const floor = floors[idx] ?? null
  const tables = floor?.tables ?? []

  if (overviewQuery.isLoading) {
    return (
      <section className="space-y-4" aria-busy="true">
        <VisionSkeletonGrid count={8} />
        <div className="grid gap-4 xl:grid-cols-3">
          <Skeleton className="h-96 rounded-2xl xl:col-span-2" />
          <Skeleton className="h-96 rounded-2xl" />
        </div>
      </section>
    )
  }

  if (overviewQuery.isError || !overview || !kpis) {
    return (
      <section>
        <VisionErrorCard onRetry={() => void overviewQuery.refetch()} />
      </section>
    )
  }

  const peopleValid =
    overridePeople.trim() === '' ||
    (Number.isFinite(Number(overridePeople)) && Number(overridePeople) >= 0)

  const submitOverride = (state: 'occupied' | 'empty') => {
    if (!overrideTarget) return
    if (!peopleValid) return
    const raw = overridePeople.trim()
    overrideMutation.mutate({
      id: overrideTarget.id,
      name: overrideTarget.name,
      state,
      peopleCount:
        state === 'occupied' && raw !== '' ? Math.max(0, Math.floor(Number(raw))) : undefined,
      reason: overrideReason.trim() === '' ? undefined : overrideReason.trim(),
    })
  }

  return (
    <section className="space-y-4">
      {/* ── KPI grid ── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          icon={<Users className="size-5" aria-hidden />}
          label={t('vision.kpi.totalGuests')}
          value={kpis.totalGuests}
        />
        <KpiCard
          icon={<CheckCircle2 className="size-5" aria-hidden />}
          label={t('vision.kpi.occupiedTables')}
          value={kpis.occupiedTables}
          sub={t('vision.kpi.covered', { n: kpis.occupiedTables, total: kpis.coveredTables })}
          progress={kpis.occupancyPct}
          progressLabel={t('vision.kpi.occupancy', { n: Math.round(kpis.occupancyPct) })}
        />
        <KpiCard
          icon={<CheckCircle2 className="size-5 text-emerald-600" aria-hidden />}
          label={t('vision.kpi.availableTables')}
          value={kpis.availableTables}
          tone="text-emerald-700"
        />
        <KpiCard
          icon={<TriangleAlert className="size-5 text-amber-600" aria-hidden />}
          label={t('vision.kpi.reviewRequired')}
          value={kpis.reviewRequired}
          sub={t('vision.kpi.reviewHint', {
            pending: kpis.pendingMovements,
            mismatches: mismatchCount,
          })}
          tone="text-amber-700"
          cardClass="border-amber-300 bg-amber-50/60"
          onClick={() => onTab('movements')}
        />
        <KpiCard
          icon={<Cctv className="size-5" aria-hidden />}
          label={t('vision.kpi.cameras')}
          value={kpis.camerasOnline}
          sub={t('vision.kpi.camerasOf', { online: kpis.camerasOnline, total: kpis.camerasTotal })}
          onClick={() => onTab('cameras')}
        />
        <KpiCard
          icon={<Clock className="size-5" aria-hidden />}
          label={t('vision.kpi.avgDwell')}
          value={formatMinutes(kpis.avgDwellMinutes)}
        />
        <KpiCard
          icon={<Users className="size-5 text-stone-400" aria-hidden />}
          label={t('vision.kpi.posOccupied')}
          value={kpis.posOccupied}
          sub={t('vision.kpi.posNote')}
          tone="text-stone-600"
          cardClass="border-dashed"
        />
      </div>

      {/* ── Live floor + alerts panel ── */}
      <div className="grid items-start gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader className="gap-3 space-y-0">
            <CardTitle className="text-base">{t('common.live')}</CardTitle>
            {/* Floor pills selector (spec) — scrolls horizontally on mobile */}
            <div className="rms-scroll flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label={t('nav.floorplans')}>
              {floors.map((f, i) => (
                <button
                  key={f.id}
                  type="button"
                  role="tab"
                  aria-selected={i === idx}
                  onClick={() => setFloorIdx(i)}
                  className={cn(
                    'h-11 shrink-0 rounded-full border px-4 text-sm font-semibold transition',
                    i === idx
                      ? 'border-primary bg-primary text-primary-foreground shadow-sm'
                      : 'border-stone-300 bg-white text-stone-600 hover:bg-stone-50',
                  )}
                >
                  {f.name}
                </button>
              ))}
            </div>
          </CardHeader>
          <CardContent>
            {tables.length === 0 ? (
              <div className="flex min-h-[280px] flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-stone-200 text-muted-foreground">
                <Users className="size-8 opacity-40" aria-hidden />
                <p className="text-sm">{t('pos.noTablesFloor')}</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
                {tables.map((tb) => {
                  const movement = pendingMovements.find((m) => m.fromTableId === tb.id) ?? null
                  return (
                    <VisionTableTile
                      key={tb.id}
                      table={tb}
                      movement={movement}
                      onOverride={() => setOverrideTarget(tb)}
                      onMovement={() => setQuickMovement(movement)}
                    />
                  )
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Alerts side panel */}
        <Card>
          <CardHeader className="space-y-0">
            <CardTitle className="flex items-center justify-between gap-2 text-base">
              <span className="flex items-center gap-2">
                {t('vision.alerts.title')}
                {overview.alerts.length > 0 && (
                  <Badge variant="outline" className="border-rose-300 bg-rose-50 text-rose-700 tabular-nums">
                    {overview.alerts.length}
                  </Badge>
                )}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-9 text-xs text-muted-foreground"
                onClick={() => onTab('alerts')}
              >
                {t('common.more')}
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            {overview.alerts.length === 0 ? (
              <p className="rounded-lg border border-dashed border-stone-200 bg-stone-50 p-4 text-sm text-muted-foreground">
                {t('vision.alerts.none')}
              </p>
            ) : (
              <ul className="rms-scroll max-h-96 space-y-2 overflow-y-auto pr-1">
                {overview.alerts.map((alert, i) => (
                  <VisionAlertRow key={`${alert.kind}-${alert.tableId ?? alert.cameraCode}-${i}`} alert={alert} />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Manual override dialog (tile tap) ── */}
      <AlertDialog
        open={overrideTarget != null}
        onOpenChange={(o) => {
          if (!o && !overrideMutation.isPending) {
            setOverrideTarget(null)
            setOverridePeople('')
            setOverrideReason('')
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('vision.override.title', { table: overrideTarget?.name ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  {t('vision.override.current', {
                    state:
                      overrideTarget?.vision.state === 'occupied'
                        ? t('vision.state.occupied')
                        : overrideTarget?.vision.state === 'empty'
                          ? t('vision.state.empty')
                          : t('vision.state.unknown'),
                  })}
                </p>
                <p className="text-xs font-medium text-amber-700">
                  {t('vision.override.humanWins', {
                    minutes: overview.config.manualHoldMinutes,
                  })}
                </p>
                <div className="space-y-1.5">
                  <Label htmlFor="override-people" className="text-xs">
                    {t('vision.override.people')}
                  </Label>
                  <Input
                    id="override-people"
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={30}
                    className="h-11"
                    value={overridePeople}
                    onChange={(e) => setOverridePeople(e.target.value)}
                    aria-invalid={!peopleValid}
                    placeholder="2"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="override-reason" className="text-xs">
                    {t('vision.override.reason')}
                  </Label>
                  <Input
                    id="override-reason"
                    className="h-11"
                    value={overrideReason}
                    onChange={(e) => setOverrideReason(e.target.value)}
                  />
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={overrideMutation.isPending}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="border border-emerald-300 bg-white text-emerald-700 hover:bg-emerald-50"
              disabled={overrideMutation.isPending || !peopleValid}
              onClick={(e) => {
                e.preventDefault()
                submitOverride('empty')
              }}
            >
              {t('vision.override.setEmpty')}
            </AlertDialogAction>
            <AlertDialogAction
              className="bg-amber-600 text-white hover:bg-amber-700"
              disabled={overrideMutation.isPending || !peopleValid}
              onClick={(e) => {
                e.preventDefault()
                submitOverride('occupied')
              }}
            >
              {overrideMutation.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {t('vision.override.setOccupied')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Pending movement quick review (tile chip) ── */}
      <MovementQuickDialog
        movement={quickMovement}
        open={quickMovement != null}
        onOpenChange={(o) => {
          if (!o) setQuickMovement(null)
        }}
        onDone={() => setQuickMovement(null)}
      />
    </section>
  )
}

// ─── KPI card ────────────────────────────────────────────────────────

function KpiCard({
  icon,
  label,
  value,
  sub,
  tone,
  cardClass,
  progress,
  progressLabel,
  onClick,
}: {
  icon: ReactNode
  label: string
  value: string | number
  sub?: string
  tone?: string
  cardClass?: string
  progress?: number
  progressLabel?: string
  onClick?: () => void
}) {
  const { t } = useI18n()
  const inner = (
    <Card className={cn('gap-2 p-4 text-start', cardClass)}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <span className="text-muted-foreground">{icon}</span>
      </div>
      <p className={cn('text-2xl font-extrabold tabular-nums leading-none', tone)}>{value}</p>
      {progress != null && (
        <div className="space-y-1">
          <Progress value={Math.min(100, Math.max(0, progress))} className="h-2 bg-stone-200" />
          {progressLabel && (
            <p className="text-[11px] text-muted-foreground tabular-nums">{progressLabel}</p>
          )}
        </div>
      )}
      {sub && progress == null && <p className="text-[11px] text-muted-foreground">{sub}</p>}
    </Card>
  )
  if (!onClick) return inner
  return (
    <button
      type="button"
      onClick={onClick}
      title={t('vision.kpi.clickHint')}
      className="w-full text-start transition hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {inner}
    </button>
  )
}

// ─── Observed-floor tile ─────────────────────────────────────────────

function VisionTableTile({
  table,
  movement,
  onOverride,
  onMovement,
}: {
  table: VisionFloorTableDTO
  movement: MovementCandidateDTO | null
  onOverride: () => void
  onMovement: () => void
}) {
  const { t } = useI18n()
  const v = table.vision
  const state = v.state
  const mismatch = table.mismatch
  const heat = state === 'occupied' ? visionHeat(v.stateSince) : null
  const hold = isManualHoldActive(v.manualHoldUntil)
  const noZone = table.zoneId == null
  const isRound = table.shape === 'round' || table.shape === 'oval'
  // chips live at the bottom corner (MERGED-style top corner stays free)
  const chipPos = isRound ? 'left-1/2 bottom-1 -translate-x-1/2' : 'start-1 bottom-1'
  const holdPos = isRound ? 'left-1/2 top-1 -translate-x-1/2' : 'end-1 top-1'

  const surface =
    state === 'occupied' && heat
      ? heat.tile
      : state === 'empty' && mismatch === 'left_check_open'
        ? 'border-violet-300 bg-violet-50 text-violet-900 ring-1 ring-violet-400'
        : state === 'empty'
          ? 'border-[#E2E2E0] bg-white text-stone-500'
          : 'border-dashed border-stone-300 bg-stone-100 text-stone-400'

  return (
    <button
      type="button"
      onClick={onOverride}
      aria-label={`${table.name} — ${t(`vision.state.${state}`)}`}
      className={cn(
        'relative flex min-w-0 flex-col items-center justify-center gap-1 overflow-hidden border p-3 text-center shadow-sm transition hover:shadow-md active:scale-[0.97]',
        shapeClasses(table.shape),
        isRound && 'px-4',
        surface,
        state === 'occupied' && mismatch === 'seated_no_order' && 'ring-2 ring-amber-400',
        noZone && 'opacity-60',
      )}
    >
      <p className="max-w-full truncate text-base font-bold leading-tight">{table.name}</p>

      {/* OBSERVED OCCUPIED — people + elapsed + camera caption */}
      {state === 'occupied' && (
        <>
          <p className={cn('flex items-center gap-1.5 text-xs font-semibold', heat?.meta)}>
            <Users className="size-3.5" aria-hidden />
            {v.peopleCount > 0 ? v.peopleCount : '—'}
            <Clock className="size-3" aria-hidden />
            {v.stateSince ? elapsedSince(v.stateSince) : '—'}
          </p>
          {table.cameraCode && (
            <p className="max-w-full truncate font-mono text-[9px] uppercase text-stone-400">
              {table.cameraCode}
            </p>
          )}
        </>
      )}

      {/* OBSERVED EMPTY — available, or violet left-check-open */}
      {state === 'empty' && (
        <p className="text-xs font-semibold">
          {mismatch === 'left_check_open' ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-violet-400/70 bg-white px-2 py-0.5 text-[10px] font-bold text-violet-700">
              {t('vision.mismatch.leftCheckOpen')}
            </span>
          ) : (
            t('vision.state.empty')
          )}
        </p>
      )}

      {/* UNKNOWN — no zone data yet */}
      {state !== 'occupied' && state !== 'empty' && (
        <p className="flex flex-col items-center gap-0.5 text-xs font-semibold">
          {t('vision.state.unknown')}
          {!v.cameraOnline && (
            <span className="text-[10px] font-medium text-stone-400">{t('vision.cameraOffline')}</span>
          )}
        </p>
      )}

      {/* occupied + seated-no-order mismatch badge */}
      {state === 'occupied' && mismatch === 'seated_no_order' && (
        <span className="inline-flex items-center rounded-full border border-amber-400/70 bg-white/80 px-2 py-0.5 text-[10px] font-bold text-amber-700">
          {t('vision.mismatch.seatedNoOrder')}
        </span>
      )}

      {/* no zone mapped */}
      {noZone && (
        <span className="absolute inset-x-0 top-0 bg-stone-900/5 py-[1px] text-[8px] font-bold uppercase tracking-wide text-stone-500">
          {t('vision.noZone')}
        </span>
      )}

      {/* manual hold (human override freeze) */}
      {hold && (
        <span
          className={cn(
            'absolute inline-flex items-center gap-0.5 rounded-full border border-amber-400 bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold text-amber-800',
            holdPos,
          )}
        >
          <Hand className="size-2.5" aria-hidden />
          {t('vision.manualHold')}
        </span>
      )}

      {/* pending AI move chip (source table) → quick review dialog */}
      {movement && (
        <span
          role="button"
          tabIndex={0}
          aria-label={t('vision.chipMoveAria', { table: table.name })}
          onClick={(e) => {
            e.stopPropagation()
            onMovement()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              e.stopPropagation()
              onMovement()
            }
          }}
          className={cn(
            'absolute z-10 inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold text-amber-800 shadow-sm cursor-pointer',
            chipPos,
          )}
        >
          <PersonStanding className="size-2.5" aria-hidden />
          {movement.peopleCount}
        </span>
      )}
    </button>
  )
}
