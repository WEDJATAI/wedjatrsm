'use client'

// ─── Shared presentational bits for the vision tabs ──────────────────
// Error cards, data-provenance chips and the alert row rendering used by
// both the Overview panel and the full Alerts tab.

import type { ReactNode } from 'react'
import { CircleAlert, Info, OctagonAlert, TriangleAlert } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { elapsedSince } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import type { VisionAlertDTO } from '@/lib/types'
import { cn } from '@/lib/utils'

import { alertSeverityClass } from './vision-utils'

/** Per-tab error state with a retry button (backend may be mid-deploy). */
export function VisionErrorCard({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n()
  return (
    <Card className="border-rose-200">
      <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
        <CircleAlert className="size-8 text-rose-400" aria-hidden />
        <p className="text-sm font-medium text-rose-700">{t('vision.loadFailed')}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      </CardContent>
    </Card>
  )
}

/** Standard loading skeleton for a grid of cards. */
export function VisionSkeletonGrid({ count = 4, tile }: { count?: number; tile?: boolean }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        <div
          key={i}
          className={cn(
            'animate-pulse rounded-2xl border border-stone-200 bg-stone-100',
            tile ? 'aspect-square' : 'h-28',
          )}
        />
      ))}
    </div>
  )
}

/**
 * Data-provenance chip — analytics numbers are labelled so predictions
 * are NEVER shown as measured facts.
 */
export function ProvenanceChip({ kind }: { kind: 'observed' | 'estimated' | 'humanConfirmed' }) {
  const { t } = useI18n()
  const cls =
    kind === 'observed'
      ? 'border-stone-300 bg-stone-100 text-stone-600'
      : kind === 'estimated'
        ? 'border-amber-400 bg-amber-50 text-amber-700'
        : 'border-emerald-400 bg-emerald-50 text-emerald-700'
  return (
    <Badge variant="outline" className={cn('text-[10px] uppercase tracking-wide', cls)}>
      {t(`vision.analytics.${kind === 'humanConfirmed' ? 'humanConfirmed' : kind}`)}
    </Badge>
  )
}

/** Alert severity → icon (critical rose / warning amber / info stone). */
export function AlertSeverityIcon({ severity, className }: { severity: string; className?: string }) {
  if (severity === 'critical') return <OctagonAlert className={className} aria-hidden />
  if (severity === 'warning') return <TriangleAlert className={className} aria-hidden />
  return <Info className={className} aria-hidden />
}

/**
 * One alert row: severity icon + translated message + table + camera +
 * elapsed since + people count. Shared by the Overview side panel and
 * the roomier Alerts tab list.
 */
export function VisionAlertRow({
  alert,
  roomy = false,
}: {
  alert: VisionAlertDTO
  roomy?: boolean
}) {
  const { t } = useI18n()
  return (
    <li
      className={cn(
        'flex items-start gap-2.5 rounded-lg border px-3',
        roomy ? 'py-3' : 'py-2',
        alertSeverityClass(alert.severity),
      )}
    >
      <AlertSeverityIcon
        severity={alert.severity}
        className={cn('mt-0.5 shrink-0', roomy ? 'size-5' : 'size-4')}
      />
      <div className="min-w-0 flex-1">
        <p className={cn('font-semibold leading-snug', roomy ? 'text-sm' : 'text-xs')}>
          {t(`vision.alerts.${alert.messageKey}`)}
        </p>
        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          {alert.tableName && <span className="font-semibold tabular-nums">{alert.tableName}</span>}
          {alert.cameraCode && (
            <span className="font-mono text-[10px] uppercase">{alert.cameraCode}</span>
          )}
          {alert.since && <span className="tabular-nums">{elapsedSince(alert.since)}</span>}
          {alert.peopleCount != null && (
            <span className="tabular-nums">· {t('vision.people', { n: alert.peopleCount })}</span>
          )}
        </p>
      </div>
    </li>
  )
}

/** Small labelled stat block (analytics movement/event sections). */
export function StatBlock({
  label,
  value,
  chip,
  className,
}: {
  label: string
  value: ReactNode
  chip?: ReactNode
  className?: string
}) {
  return (
    <div className={cn('rounded-xl border bg-card p-4', className)}>
      <div className="flex flex-wrap items-center justify-between gap-1">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {chip}
      </div>
      <p className="mt-1 text-xl font-bold tabular-nums">{value}</p>
    </div>
  )
}
