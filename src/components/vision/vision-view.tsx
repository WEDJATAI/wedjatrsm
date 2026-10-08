'use client'

// ─── AI Vision / CCTV seating intelligence — main container (R9) ─────
// 7-tab admin view: Overview (live floor), Cameras, Zones (polygon
// editor), Movements (human review center), Alerts, Analytics and the
// Simulator. Polls /api/vision/overview every 5s. The view is purely
// observational: operational POS changes happen ONLY through the
// human-confirmed movement flow (see movement-actions.ts).

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeftRight,
  BarChart3,
  BellRing,
  Cctv,
  FlaskConical,
  LayoutDashboard,
  Loader2,
  RefreshCw,
  Sparkles,
  SquareDashed,
} from 'lucide-react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { apiFetch, fetcher } from '@/lib/api'
import { formatTime, toDateInputValue } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import type {
  FloorPlan,
  MovementCandidateDTO,
  VisionAnalyticsDTO,
  VisionCameraDTO,
  VisionConfigDTO,
  VisionOverviewDTO,
  VisionZoneDTO,
} from '@/lib/types'

import VisionOverviewTab from './vision-overview-tab'
import VisionCamerasTab from './vision-cameras-tab'
import VisionZonesTab from './vision-zones-tab'
import VisionMovementsTab from './vision-movements-tab'
import VisionAlertsTab from './vision-alerts-tab'
import VisionAnalyticsTab from './vision-analytics-tab'
import VisionSimulatorTab from './vision-simulator-tab'

export type VisionTab = 'overview' | 'cameras' | 'zones' | 'movements' | 'alerts' | 'analytics' | 'simulator'

export type MovementFilter = 'pending' | 'confirmed' | 'rejected' | 'conflict' | 'all'

export type VisionIngestInfo = { key: string; endpoint: string }

function daysAgoValue(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return toDateInputValue(d)
}

export default function VisionView() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const [tab, setTab] = useState<VisionTab>('overview')
  const [movementStatus, setMovementStatus] = useState<MovementFilter>('pending')
  const [analyticsRange, setAnalyticsRange] = useState(() => ({
    from: daysAgoValue(6),
    to: daysAgoValue(0),
  }))
  const [refreshing, setRefreshing] = useState(false)

  // ── Shared queries (contract with /api/vision/** — agent 9-a) ──────
  const overviewQuery = useQuery({
    queryKey: ['vision-overview'],
    queryFn: () => fetcher<{ overview: VisionOverviewDTO }>('/api/vision/overview'),
    refetchInterval: 5_000, // LIVE floor state
  })

  const camerasQuery = useQuery({
    queryKey: ['vision-cameras'],
    queryFn: () => fetcher<{ cameras: VisionCameraDTO[] }>('/api/vision/cameras'),
  })

  const zonesQuery = useQuery({
    queryKey: ['vision-zones'],
    queryFn: () => fetcher<{ zones: VisionZoneDTO[] }>('/api/vision/zones'),
  })

  const configQuery = useQuery({
    queryKey: ['vision-config'],
    queryFn: () =>
      fetcher<{ config: VisionConfigDTO; ingest: VisionIngestInfo }>('/api/vision/config'),
  })

  const floorplansQuery = useQuery({
    queryKey: ['floorplans'],
    queryFn: () => fetcher<{ floorPlans: FloorPlan[] }>('/api/floorplans'),
  })

  const movementsQuery = useQuery({
    queryKey: ['vision-movements', movementStatus],
    queryFn: () =>
      fetcher<{ movements: MovementCandidateDTO[] }>(
        `/api/vision/movements?status=${movementStatus}`,
      ),
    refetchInterval: 8_000,
  })

  const analyticsQuery = useQuery({
    queryKey: ['vision-analytics', analyticsRange.from, analyticsRange.to],
    queryFn: () =>
      fetcher<{ analytics: VisionAnalyticsDTO }>(
        `/api/vision/analytics?from=${analyticsRange.from}&to=${analyticsRange.to}`,
      ),
    enabled: tab === 'analytics',
  })

  // Demo setup — idempotent CAM-001/CAM-002 + zones for all floor tables.
  const setupDemoMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ results: { event_id: string; outcome: string; detail: string | null }[] }>(
        '/api/vision/simulate',
        { body: { scenario: 'setup_demo' } },
      ),
    onSuccess: async () => {
      toast.success(t('vision.setupDone'))
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['vision-cameras'] }),
        queryClient.invalidateQueries({ queryKey: ['vision-zones'] }),
        queryClient.invalidateQueries({ queryKey: ['vision-overview'] }),
      ])
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const overview = overviewQuery.data?.overview
  const cameras = camerasQuery.data?.cameras ?? []
  const zones = zonesQuery.data?.zones ?? []
  const floorPlans = floorplansQuery.data?.floorPlans ?? []
  const movements = movementsQuery.data?.movements ?? []

  const pendingCount = overview?.kpis.pendingMovements ?? 0
  const alertCount = overview?.alerts.length ?? 0
  const noCameras = !camerasQuery.isLoading && !camerasQuery.isError && cameras.length === 0

  const refreshAll = async () => {
    setRefreshing(true)
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['vision-overview'] }),
        queryClient.invalidateQueries({ queryKey: ['vision-cameras'] }),
        queryClient.invalidateQueries({ queryKey: ['vision-zones'] }),
        queryClient.invalidateQueries({ queryKey: ['vision-movements'] }),
        queryClient.invalidateQueries({ queryKey: ['vision-config'] }),
        queryClient.invalidateQueries({ queryKey: ['vision-analytics'] }),
        queryClient.invalidateQueries({ queryKey: ['floorplans'] }),
      ])
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-4 p-4 sm:space-y-6 sm:p-6">
      {/* ── Page header ── */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="grid size-12 shrink-0 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-sm">
            <Cctv className="size-6" aria-hidden />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold sm:text-2xl">{t('vision.title')}</h1>
            <p className="text-sm text-muted-foreground">{t('vision.subtitle')}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className="gap-1.5 border-emerald-300 bg-emerald-50 py-1 text-emerald-700"
          >
            <span className="relative flex size-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
            </span>
            {t('common.live')}
          </Badge>
          {overview && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {t('vision.lastUpdated', { time: formatTime(overview.updatedAt) })}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-11 gap-1.5 px-4"
            onClick={() => void refreshAll()}
            disabled={refreshing}
            aria-label={t('common.refresh')}
          >
            <RefreshCw className={refreshing ? 'size-4 animate-spin' : 'size-4'} aria-hidden />
            {t('common.refresh')}
          </Button>
        </div>
      </header>

      {/* ── Empty state: no cameras yet (demo onboarding) ── */}
      {noCameras && (
        <Card className="border-amber-200 bg-amber-50/60">
          <CardContent className="flex flex-col items-start gap-3 p-6">
            <div className="flex items-center gap-2">
              <Sparkles className="size-5 text-amber-600" aria-hidden />
              <p className="font-semibold text-amber-900">{t('vision.noCamerasTitle')}</p>
            </div>
            <p className="max-w-2xl text-sm leading-relaxed text-amber-800/90">
              {t('vision.noCamerasHint')}
            </p>
            <Button
              className="h-11 gap-1.5 px-5"
              disabled={setupDemoMutation.isPending}
              onClick={() => setupDemoMutation.mutate()}
            >
              {setupDemoMutation.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
              <Sparkles className="size-4" aria-hidden />
              {t('vision.setupDemo')}
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ── 7 tabs ── */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as VisionTab)}>
        <TabsList className="rms-scroll h-11 w-full justify-start overflow-x-auto p-1">
          <TabsTrigger value="overview" className="h-9 gap-1.5 px-3">
            <LayoutDashboard aria-hidden />
            <span className="hidden sm:inline">{t('vision.tabs.overview')}</span>
          </TabsTrigger>
          <TabsTrigger value="cameras" className="h-9 gap-1.5 px-3">
            <Cctv aria-hidden />
            <span className="hidden sm:inline">{t('vision.tabs.cameras')}</span>
          </TabsTrigger>
          <TabsTrigger value="zones" className="h-9 gap-1.5 px-3">
            <SquareDashed aria-hidden />
            <span className="hidden sm:inline">{t('vision.tabs.zones')}</span>
          </TabsTrigger>
          <TabsTrigger value="movements" className="h-9 gap-1.5 px-3">
            <ArrowLeftRight aria-hidden />
            <span className="hidden sm:inline">{t('vision.tabs.movements')}</span>
            {pendingCount > 0 && (
              <span className="rounded-full bg-amber-100 px-1.5 text-[10px] font-bold text-amber-800 tabular-nums">
                {pendingCount}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="alerts" className="h-9 gap-1.5 px-3">
            <BellRing aria-hidden />
            <span className="hidden sm:inline">{t('vision.tabs.alerts')}</span>
            {alertCount > 0 && (
              <span className="rounded-full bg-rose-100 px-1.5 text-[10px] font-bold text-rose-700 tabular-nums">
                {alertCount}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="analytics" className="h-9 gap-1.5 px-3">
            <BarChart3 aria-hidden />
            <span className="hidden sm:inline">{t('vision.tabs.analytics')}</span>
          </TabsTrigger>
          <TabsTrigger value="simulator" className="h-9 gap-1.5 px-3">
            <FlaskConical aria-hidden />
            <span className="hidden sm:inline">{t('vision.tabs.simulator')}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-4 space-y-4">
          <VisionOverviewTab
            overviewQuery={overviewQuery}
            onTab={setTab}
          />
        </TabsContent>

        <TabsContent value="cameras" className="mt-4 space-y-4">
          <VisionCamerasTab
            cameras={cameras}
            isLoading={camerasQuery.isLoading}
            isError={camerasQuery.isError}
            refetch={camerasQuery.refetch}
            config={configQuery.data?.config}
            ingest={configQuery.data?.ingest}
            configLoading={configQuery.isLoading}
            configError={configQuery.isError}
            configRefetch={configQuery.refetch}
            floorPlans={floorPlans}
            setupDemoMutation={setupDemoMutation}
          />
        </TabsContent>

        <TabsContent value="zones" className="mt-4 space-y-4">
          <VisionZonesTab
            cameras={cameras}
            zones={zones}
            isLoading={zonesQuery.isLoading}
            isError={zonesQuery.isError}
            refetch={zonesQuery.refetch}
            floorPlans={floorPlans}
          />
        </TabsContent>

        <TabsContent value="movements" className="mt-4 space-y-4">
          <VisionMovementsTab
            movements={movements}
            isLoading={movementsQuery.isLoading}
            isError={movementsQuery.isError}
            refetch={movementsQuery.refetch}
            status={movementStatus}
            onStatusChange={setMovementStatus}
            pendingCount={pendingCount}
          />
        </TabsContent>

        <TabsContent value="alerts" className="mt-4 space-y-4">
          <VisionAlertsTab
            overview={overview}
            isLoading={overviewQuery.isLoading}
            isError={overviewQuery.isError}
            refetch={overviewQuery.refetch}
          />
        </TabsContent>

        <TabsContent value="analytics" className="mt-4 space-y-4">
          <VisionAnalyticsTab
            analytics={analyticsQuery.data?.analytics}
            isLoading={analyticsQuery.isLoading}
            isError={analyticsQuery.isError}
            refetch={analyticsQuery.refetch}
            range={analyticsRange}
            onRangeChange={setAnalyticsRange}
          />
        </TabsContent>

        <TabsContent value="simulator" className="mt-4 space-y-4">
          <VisionSimulatorTab cameras={cameras} floorPlans={floorPlans} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
