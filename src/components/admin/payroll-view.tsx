'use client'

// R17 Payroll (Odoo HR lite) — attendance hours × hourly rate for one
// calendar month. Period control (this/last month), KPI row, per-member
// table with inline hourly-rate editing for admins (PUT /api/users/[id]),
// totals footer, empty/loading/error states.

import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  CalendarDays,
  Check,
  Clock,
  Pencil,
  Timer,
  TriangleAlert,
  Wallet,
  X,
} from 'lucide-react'

import { apiFetch, fetcher } from '@/lib/api'
import { formatCurrency } from '@/lib/format'
import type { PayrollReport, SessionUser } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

type Period = 'this' | 'last'

function monthString(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

const ROLE_BADGE_CLASS: Record<string, string> = {
  admin: 'border-primary/40 bg-primary/10 text-primary',
  waiter:
    'border-emerald-600/40 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-400',
  kitchen:
    'border-rose-600/40 bg-rose-50 text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-400',
  custom:
    'border-amber-600/40 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-400',
}

const ROLE_AVATAR_CLASS: Record<string, string> = {
  admin: 'bg-primary/15 text-primary',
  waiter: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400',
  kitchen: 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-400',
  custom: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-400',
}

function roleLabelKey(role: string): string {
  return role === 'admin' || role === 'waiter' || role === 'kitchen' || role === 'custom'
    ? `role.${role}`
    : 'role.custom'
}

// ─── View ───────────────────────────────────────────────────────────

export default function PayrollView() {
  const { t, lang } = useI18n()

  // component-local (the r17 dict is owned elsewhere) — invalid-rate toast
  const rateInvalidMsg =
    lang === 'ar' ? 'أدخل أجرًا صحيحًا (0 أو أكثر)' : 'Enter a valid rate (0 or more)'
  const queryClient = useQueryClient()

  const [period, setPeriod] = useState<Period>('this')
  const month = useMemo(() => {
    const now = new Date()
    // 'last' = previous calendar month relative to the client clock
    return monthString(new Date(now.getFullYear(), now.getMonth() + (period === 'last' ? -1 : 0), 1))
  }, [period])

  const payrollQuery = useQuery({
    queryKey: ['payroll-report', month],
    queryFn: () => fetcher<PayrollReport>(`/api/reports/payroll?month=${month}`),
  })

  // Shared session cache (page.tsx) — admins (or 'users' permission holders)
  // may edit hourly rates inline; the PUT /api/users/[id] guard matches this.
  const sessionQuery = useQuery({
    queryKey: ['session'],
    queryFn: () => fetcher<{ user: SessionUser }>('/api/auth/me'),
    staleTime: 60_000,
  })
  const canEditRates =
    sessionQuery.data?.user.role === 'admin' ||
    (sessionQuery.data?.user.permissions.includes('users') ?? false)

  // ── inline hourly-rate editing ────────────────────────────────────
  const [editing, setEditing] = useState<{ userId: number; value: string } | null>(null)

  const saveRate = useMutation({
    mutationFn: ({ userId, value }: { userId: number; value: string }) =>
      apiFetch<{ user: SessionUser }>(`/api/users/${userId}`, {
        method: 'PUT',
        body: { hourlyRate: value.trim() === '' ? null : Number(value) },
      }),
    onSuccess: () => {
      toast.success(t('r17.payroll.rateSaved'))
      setEditing(null)
      void queryClient.invalidateQueries({ queryKey: ['payroll-report'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const report = payrollQuery.data
  const lines = report?.lines ?? []
  const loading = payrollQuery.isLoading

  function startEdit(userId: number, currentRate: number | null) {
    setEditing({ userId, value: currentRate === null ? '' : String(currentRate) })
  }

  function commitEdit(userId: number) {
    if (editing === null || editing.userId !== userId) return
    if (editing.value.trim() === '') {
      setEditing(null)
      return
    }
    const parsed = Number(editing.value)
    if (!Number.isFinite(parsed) || parsed < 0) {
      toast.error(rateInvalidMsg)
      return
    }
    saveRate.mutate({ userId, value: editing.value })
  }

  const periods: { key: Period; label: string }[] = [
    { key: 'this', label: t('r17.payroll.thisMonth') },
    { key: 'last', label: t('r17.payroll.lastMonth') },
  ]

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
            <span className="font-medium text-primary">{t('nav.payroll')}</span>
          </nav>
          <h1 className="text-2xl font-bold tracking-tight">{t('r17.payroll.title')}</h1>
        </div>
      </div>

      {/* Header card: subtitle + period control */}
      <Card className="gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-sm text-muted-foreground">{t('r17.payroll.subtitle')}</p>
            <p className="text-xs tabular-nums text-muted-foreground">
              {report ? (
                <>
                  {t('r17.common.from')} {report.from} {t('r17.common.to')} {report.to}
                </>
              ) : (
                <span className="invisible">—</span>
              )}
            </p>
          </div>
          <div
            className="flex gap-2"
            role="group"
            aria-label={t('r17.payroll.period')}
          >
            {periods.map((p) => (
              <Button
                key={p.key}
                variant={period === p.key ? 'default' : 'outline'}
                size="sm"
                className="h-11"
                aria-pressed={period === p.key}
                onClick={() => setPeriod(p.key)}
              >
                {p.label}
              </Button>
            ))}
          </div>
        </div>
      </Card>

      {/* KPI row */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="gap-3 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <p className="text-xs font-medium text-muted-foreground">
                {t('r17.payroll.totalHours')}
              </p>
              {loading ? (
                <Skeleton className="h-7 w-20" />
              ) : (
                <p className="text-2xl font-bold leading-none tabular-nums">
                  {(report?.totalHours ?? 0).toFixed(2)}
                  <span className="ms-1 text-sm font-medium text-muted-foreground">h</span>
                </p>
              )}
            </div>
            <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
              <Timer className="size-4.5" aria-hidden />
            </div>
          </div>
        </Card>
        <Card className="gap-3 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <p className="text-xs font-medium text-muted-foreground">
                {t('r17.payroll.totalGross')}
              </p>
              {loading ? (
                <Skeleton className="h-7 w-24" />
              ) : (
                <p className="text-2xl font-bold leading-none tabular-nums">
                  {formatCurrency(report?.totalGrossPay ?? 0)}
                </p>
              )}
            </div>
            <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-emerald-100 text-emerald-700">
              <Wallet className="size-4.5" aria-hidden />
            </div>
          </div>
        </Card>
      </div>

      {/* Payroll table */}
      <Card className="p-4">
        {payrollQuery.isError ? (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <TriangleAlert className="size-10 text-destructive" aria-hidden />
            <div>
              <p className="font-medium">{t('r17.common.error')}</p>
              <p className="text-muted-foreground text-sm">
                {payrollQuery.error?.message ?? t('common.error')}
              </p>
            </div>
            <Button
              variant="outline"
              className="h-11"
              onClick={() => void payrollQuery.refetch()}
            >
              {t('r17.common.retry')}
            </Button>
          </div>
        ) : loading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className="flex items-center gap-4 rounded-lg border p-3">
                <Skeleton className="size-9 rounded-full" />
                <Skeleton className="h-4 w-36" />
                <Skeleton className="ms-auto h-4 w-16" />
                <Skeleton className="h-4 w-14" />
                <Skeleton className="h-4 w-20" />
              </div>
            ))}
          </div>
        ) : lines.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <CalendarDays className="size-10 text-muted-foreground/50" aria-hidden />
            <div>
              <p className="font-medium">{t('r17.payroll.empty')}</p>
              <p className="text-muted-foreground text-sm">{t('r17.payroll.noRateHint')}</p>
            </div>
          </div>
        ) : (
          <>
            <div className="rms-scroll max-h-96 overflow-y-auto">
              <Table>
                <TableHeader className="sticky top-0 bg-card">
                  <TableRow>
                    <TableHead>{t('r17.payroll.user')}</TableHead>
                    <TableHead>{t('r17.payroll.rate')}</TableHead>
                    <TableHead className="hidden md:table-cell">
                      {t('r17.payroll.sessions')}
                    </TableHead>
                    <TableHead className="text-right">{t('r17.payroll.hours')}</TableHead>
                    <TableHead className="hidden text-right md:table-cell">
                      {t('r17.payroll.late')}
                    </TableHead>
                    <TableHead className="text-right">{t('r17.payroll.grossPay')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((line) => {
                    const isEditing = editing?.userId === line.userId
                    return (
                      <TableRow key={line.userId} className="h-16">
                        {/* team member */}
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <Avatar className="size-9">
                              <AvatarFallback
                                className={cn(
                                  'text-xs font-semibold',
                                  ROLE_AVATAR_CLASS[line.role] ?? ROLE_AVATAR_CLASS.custom,
                                )}
                              >
                                {initials(line.name)}
                              </AvatarFallback>
                            </Avatar>
                            <div className="min-w-0">
                              <div className="truncate font-medium">{line.name}</div>
                              <Badge
                                variant="outline"
                                className={cn(
                                  'mt-0.5 px-1.5 text-[10px]',
                                  ROLE_BADGE_CLASS[line.role] ?? ROLE_BADGE_CLASS.custom,
                                )}
                              >
                                {t(roleLabelKey(line.role))}
                              </Badge>
                            </div>
                          </div>
                        </TableCell>
                        {/* hourly rate — inline editable for admins */}
                        <TableCell>
                          {isEditing ? (
                            <div className="flex items-center gap-1">
                              <Input
                                type="number"
                                inputMode="decimal"
                                min={0}
                                step={0.5}
                                value={editing.value}
                                autoFocus
                                aria-label={t('r17.payroll.rateLabel')}
                                className="h-9 w-24"
                                onChange={(e) =>
                                  setEditing({ userId: line.userId, value: e.target.value })
                                }
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') commitEdit(line.userId)
                                  if (e.key === 'Escape') setEditing(null)
                                }}
                              />
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="size-9 text-emerald-700 dark:text-emerald-400"
                                aria-label={t('r17.common.save')}
                                disabled={saveRate.isPending}
                                onClick={() => commitEdit(line.userId)}
                              >
                                <Check className="size-4" aria-hidden />
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="size-9 text-muted-foreground"
                                aria-label={t('r17.common.cancel')}
                                onClick={() => setEditing(null)}
                              >
                                <X className="size-4" aria-hidden />
                              </Button>
                            </div>
                          ) : (
                            <span className="inline-flex items-center gap-1.5 tabular-nums">
                              {line.hourlyRate === null ? (
                                <span className="text-muted-foreground">—</span>
                              ) : (
                                <>
                                  {formatCurrency(line.hourlyRate)}
                                  <span className="text-xs text-muted-foreground">/h</span>
                                </>
                              )}
                              {canEditRates ? (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="size-7 text-muted-foreground hover:text-primary"
                                  aria-label={t('r17.payroll.setRate')}
                                  title={t('r17.payroll.setRate')}
                                  onClick={() => startEdit(line.userId, line.hourlyRate)}
                                >
                                  <Pencil className="size-3.5" aria-hidden />
                                </Button>
                              ) : null}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="hidden tabular-nums md:table-cell">
                          {line.sessions}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {line.hours.toFixed(2)}
                        </TableCell>
                        <TableCell
                          className={cn(
                            'hidden text-right tabular-nums md:table-cell',
                            line.lateMinutes > 0
                              ? 'font-medium text-amber-700 dark:text-amber-400'
                              : 'text-muted-foreground',
                          )}
                        >
                          <span className="inline-flex items-center justify-end gap-1">
                            {line.lateMinutes > 0 ? <Clock className="size-3" aria-hidden /> : null}
                            {line.lateMinutes}
                          </span>
                        </TableCell>
                        <TableCell className="text-right font-semibold tabular-nums">
                          {formatCurrency(line.grossPay)}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
                <TableFooter className="sticky bottom-0 bg-card">
                  <TableRow>
                    <TableCell colSpan={3} className="font-medium">
                      {t('r17.common.total')}
                    </TableCell>
                    <TableCell className="text-right font-semibold tabular-nums">
                      {(report?.totalHours ?? 0).toFixed(2)}
                    </TableCell>
                    <TableCell className="hidden md:table-cell" />
                    <TableCell className="text-right font-semibold tabular-nums">
                      {formatCurrency(report?.totalGrossPay ?? 0)}
                    </TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            </div>
            <p className="mt-3 flex items-start gap-1.5 text-xs text-muted-foreground">
              <Wallet className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {t('r17.payroll.noRateHint')}
            </p>
          </>
        )}
      </Card>
    </div>
  )
}
