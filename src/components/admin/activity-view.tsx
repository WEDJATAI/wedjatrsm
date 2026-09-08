'use client'

// ─── Admin · Activity (audit trail) ─────────────────────────────────
// Live trail of sensitive actions recorded by lib/audit (logAudit) —
// orders/payments/defers/cancels, table turnover, settings, users/roles
// and inventory adjustments. Polled every 5s; filterable by action and
// date range; newest first, paginated 50 rows per page.

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  ScrollText,
  TriangleAlert,
} from 'lucide-react'

import { fetcher } from '@/lib/api'
import { AUDIT_ACTIONS } from '@/lib/audit'
import { formatDate, formatTime } from '@/lib/format'
import type { AuditLogPage } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

const PAGE_SIZE = 50
const ALL_ACTIONS = 'all'

/** action code → i18n key, e.g. 'order.itemDelete' → 'audit.action.orderItemDelete'. */
function actionLabelKey(action: string): string {
  const [entity, ...rest] = action.split('.')
  const camel =
    entity + rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('')
  return `audit.action.${camel}`
}

/* Soft category tones (warm palette — no blue/indigo). */
const TONE_EMERALD =
  'border-emerald-600/30 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400'
const TONE_ROSE =
  'border-rose-600/30 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-400'
const TONE_AMBER =
  'border-amber-600/40 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-400'
const TONE_VIOLET =
  'border-violet-400/40 bg-violet-100 text-violet-800 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-400'
const TONE_VIOLET_SOFT =
  'border-violet-300/60 bg-violet-50 text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300'
const TONE_STONE =
  'border-stone-300 bg-stone-100 text-stone-700 dark:border-stone-500/40 dark:bg-stone-500/10 dark:text-stone-300'
const TONE_ORANGE =
  'border-orange-400/40 bg-orange-100 text-orange-800 dark:border-orange-500/40 dark:bg-orange-500/10 dark:text-orange-400'
const TONE_PLUM = 'border-primary/30 bg-primary/10 text-primary'

const ACTION_TONE: Record<string, string> = {
  // payments / closing → emerald
  'order.create': TONE_EMERALD,
  'order.payment': TONE_EMERALD,
  'order.deferSettle': TONE_EMERALD,
  // cancels + deletes → rose
  'order.cancel': TONE_ROSE,
  'order.itemDelete': TONE_ROSE,
  'user.delete': TONE_ROSE,
  'role.delete': TONE_ROSE,
  // tables → amber
  'table.bus': TONE_AMBER,
  'table.clean': TONE_AMBER,
  // users / roles → violet
  'user.create': TONE_VIOLET,
  'user.update': TONE_VIOLET,
  'role.create': TONE_VIOLET,
  'role.update': TONE_VIOLET,
  // defer → violet (soft)
  'order.defer': TONE_VIOLET_SOFT,
  // settings → stone
  'settings.update': TONE_STONE,
  // inventory → orange
  'inventory.adjust': TONE_ORANGE,
  // order moves (transfer / merge) → plum (theme)
  'order.transfer': TONE_PLUM,
  'order.merge': TONE_PLUM,
  'order.itemTransfer': TONE_PLUM,
}

export default function ActivityView() {
  const { t } = useI18n()

  // filters (page resets to 1 whenever any filter changes)
  const [action, setAction] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [page, setPage] = useState(1)

  const queryString = useMemo(() => {
    const sp = new URLSearchParams()
    sp.set('page', String(page))
    sp.set('pageSize', String(PAGE_SIZE))
    if (action !== '') sp.set('action', action)
    if (from !== '') sp.set('from', from)
    if (to !== '') sp.set('to', to)
    return sp.toString()
  }, [page, action, from, to])

  const logsQuery = useQuery({
    queryKey: ['audit', { page, action, from, to }],
    queryFn: () => fetcher<AuditLogPage>(`/api/audit?${queryString}`),
    refetchInterval: 5_000, // live trail
  })

  const logs = logsQuery.data?.logs ?? []
  const total = logsQuery.data?.total ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const loading = logsQuery.isLoading

  function changeAction(value: string) {
    setAction(value === ALL_ACTIONS ? '' : value)
    setPage(1)
  }

  function changeFrom(value: string) {
    setFrom(value)
    setPage(1)
  }

  function changeTo(value: string) {
    setTo(value)
    setPage(1)
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      {/* Header — Odoo control-panel style */}
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="space-y-1">
          <nav aria-label="Breadcrumb" className="text-xs text-muted-foreground">
            <span>{t('nav.home')}</span>
            <span className="mx-1.5" aria-hidden>
              /
            </span>
            <span className="font-medium text-primary">{t('nav.activity')}</span>
          </nav>
          <h1 className="text-2xl font-bold tracking-tight">{t('admin.activityTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('admin.activitySubtitle')}</p>
        </div>
      </div>

      {/* Filters: action + date range + refresh */}
      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Select value={action === '' ? ALL_ACTIONS : action} onValueChange={changeAction}>
            <SelectTrigger
              className="h-11 w-full sm:w-52"
              aria-label={t('admin.activityFilterAction')}
            >
              <SelectValue placeholder={t('admin.activityAllActions')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_ACTIONS}>{t('admin.activityAllActions')}</SelectItem>
              {AUDIT_ACTIONS.map((auditAction) => (
                <SelectItem key={auditAction} value={auditAction}>
                  {t(actionLabelKey(auditAction))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            type="date"
            value={from}
            onChange={(e) => changeFrom(e.target.value)}
            className="h-11 w-full sm:w-40"
            aria-label={t('admin.activityFilterFrom')}
          />
          <Input
            type="date"
            value={to}
            onChange={(e) => changeTo(e.target.value)}
            className="h-11 w-full sm:w-40"
            aria-label={t('admin.activityFilterTo')}
          />
          <Button
            variant="outline"
            className="h-11"
            onClick={() => void logsQuery.refetch()}
            disabled={logsQuery.isFetching}
          >
            <RefreshCw className={cn('size-4', logsQuery.isFetching && 'animate-spin')} aria-hidden />
            {t('admin.activityRefresh')}
          </Button>
          <span className="ms-auto hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
            <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" aria-hidden />
            {t('common.live')}
          </span>
        </div>
      </Card>

      {/* Log table */}
      <Card className="p-4">
        {logsQuery.isError ? (
          <div className="flex items-center justify-center gap-2 py-10 text-center">
            <TriangleAlert className="size-5 text-destructive" aria-hidden />
            <p className="text-sm font-medium text-destructive">{t('admin.activityLoadFailed')}</p>
          </div>
        ) : loading ? (
          <div className="rms-scroll max-h-[520px] space-y-2 overflow-y-auto">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex items-center gap-4 rounded-lg border p-3">
                <Skeleton className="h-5 w-20" />
                <Skeleton className="h-5 w-24" />
                <Skeleton className="h-6 w-32 rounded-full" />
                <Skeleton className="h-5 flex-1" />
              </div>
            ))}
          </div>
        ) : logs.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <ScrollText className="size-10 text-muted-foreground/50" aria-hidden />
            <p className="font-medium">{t('admin.activityEmpty')}</p>
          </div>
        ) : (
          <div className="rms-scroll max-h-[520px] overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead className="text-start">{t('admin.activityTime')}</TableHead>
                  <TableHead className="text-start">{t('admin.activityUser')}</TableHead>
                  <TableHead className="text-start">{t('admin.activityAction')}</TableHead>
                  <TableHead className="text-start">{t('admin.activityDetails')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log) => (
                  <TableRow key={log.id} className="h-14">
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-mono text-sm tabular-nums">
                          {formatTime(log.createdAt)}
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          {formatDate(log.createdAt)}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="max-w-[140px] truncate font-semibold">
                      {log.userName}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={cn(
                          'px-2 text-xs',
                          ACTION_TONE[log.action] ?? TONE_STONE,
                        )}
                      >
                        {t(actionLabelKey(log.action))}
                      </Badge>
                    </TableCell>
                    <TableCell className="min-w-[240px] whitespace-normal">
                      <span className="flex flex-wrap items-center gap-2">
                        {log.entityId != null ? (
                          <span
                            className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                            title={log.entity}
                          >
                            #{log.entityId}
                          </span>
                        ) : null}
                        <span className="text-sm text-muted-foreground">
                          {log.details ?? '—'}
                        </span>
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Pagination footer */}
        {!logsQuery.isError && !loading && logs.length > 0 ? (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t pt-4">
            <p className="text-sm text-muted-foreground">
              {t('admin.activityPage', { page, pages })}
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-11"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                <ChevronLeft className="size-4 rtl:rotate-180" aria-hidden />
                {t('admin.activityPrev')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-11"
                disabled={page >= pages}
                onClick={() => setPage((p) => Math.min(pages, p + 1))}
              >
                {t('admin.activityNext')}
                <ChevronRight className="size-4 rtl:rotate-180" aria-hidden />
              </Button>
            </div>
          </div>
        ) : null}
      </Card>
    </div>
  )
}
