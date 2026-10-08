'use client'

// ─── Vision Alerts tab — roomier full list + camera health ───────────
// Same alert rows as the Overview side panel, grouped critical-first,
// plus per-camera health (status, last error, last seen).

import { useMemo } from 'react'
import { BellRing, Cctv } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { elapsedSince } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import type { VisionOverviewDTO } from '@/lib/types'

import { VisionAlertRow, VisionErrorCard } from './vision-shared'
import { cameraStatusClass } from './vision-utils'

type Props = {
  overview: VisionOverviewDTO | undefined
  isLoading: boolean
  isError: boolean
  refetch: () => void
}

const SEVERITY_ORDER = ['critical', 'warning', 'info'] as const

export default function VisionAlertsTab({ overview, isLoading, isError, refetch }: Props) {
  const { t } = useI18n()

  const grouped = useMemo(() => {
    const alerts = overview?.alerts ?? []
    return SEVERITY_ORDER.map((severity) => ({
      severity,
      items: alerts.filter((a) => a.severity === severity),
    })).filter((g) => g.items.length > 0)
  }, [overview])

  if (isLoading) {
    return (
      <section className="space-y-4" aria-busy="true">
        <Skeleton className="h-11 w-full rounded-2xl" />
        <Skeleton className="h-64 w-full rounded-2xl" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </section>
    )
  }
  if (isError || !overview) {
    return <VisionErrorCard onRetry={refetch} />
  }

  return (
    <section className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t('vision.alerts.title')} · {overview.alerts.length}
      </p>

      {/* ── alerts grouped by severity (critical first) ── */}
      <Card>
        <CardHeader className="space-y-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <BellRing className="size-4" aria-hidden />
            {t('vision.alerts.title')}
          </CardTitle>
          <CardDescription>{t('vision.subtitle')}</CardDescription>
        </CardHeader>
        <CardContent>
          {overview.alerts.length === 0 ? (
            <p className="rounded-lg border border-dashed border-stone-200 bg-stone-50 p-4 text-sm text-muted-foreground">
              {t('vision.alerts.none')}
            </p>
          ) : (
            <div className="rms-scroll max-h-[32rem] space-y-4 overflow-y-auto pr-1">
              {grouped.map((group) => (
                <div key={group.severity} className="space-y-2">
                  <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">
                    {t(`vision.alerts.severity.${group.severity}`)}
                    <Badge variant="outline" className="tabular-nums">
                      {group.items.length}
                    </Badge>
                  </p>
                  <ul className="space-y-2">
                    {group.items.map((alert, i) => (
                      <VisionAlertRow
                        key={`${alert.kind}-${alert.tableId ?? alert.cameraCode}-${i}`}
                        alert={alert}
                        roomy
                      />
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── camera health ── */}
      <Card>
        <CardHeader className="space-y-0">
          <CardTitle className="flex items-center gap-2 text-base">
            <Cctv className="size-4" aria-hidden />
            {t('vision.alerts.camerasHealth')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="rms-scroll max-h-72 divide-y divide-stone-100 overflow-y-auto pr-1">
            {overview.cameras.map((camera) => (
              <li key={camera.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
                <code className="font-mono text-xs font-bold uppercase">{camera.code}</code>
                <span className="min-w-0 flex-1 truncate">{camera.name}</span>
                <Badge variant="outline" className={cameraStatusClass(camera.status)}>
                  {t(`vision.cameras.status.${camera.status}`)}
                </Badge>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {camera.lastSeenAt
                    ? t('common.since', { time: elapsedSince(camera.lastSeenAt) })
                    : t('vision.cameras.never')}
                </span>
                {camera.lastError && (
                  <p className="w-full truncate text-xs text-rose-600" title={camera.lastError}>
                    {camera.lastError}
                  </p>
                )}
              </li>
            ))}
            {overview.cameras.length === 0 && (
              <li className="py-3 text-sm text-muted-foreground">
                {t('vision.cameras.empty')}
              </li>
            )}
          </ul>
        </CardContent>
      </Card>
    </section>
  )
}
