'use client'

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlarmClock,
  CalendarDays,
  Clock,
  LogIn,
  Timer,
  TriangleAlert,
  UsersRound,
} from 'lucide-react'

import { fetcher } from '@/lib/api'
import { formatTime, toDateInputValue, workedDuration } from '@/lib/format'
import type { AttendanceRecord } from '@/lib/types'
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
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

type AttendanceSummary = {
  total: number
  checkedIn: number
  stillIn: number
  lateCount: number
  totalWorkedMinutes: number
}

type AttendanceResponse = {
  records: AttendanceRecord[]
  summary: AttendanceSummary
}

function daysAgoInput(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return toDateInputValue(d)
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

/** Summary number card (In now / Late / Employees / Total worked). */
function SummaryCard({
  label,
  value,
  icon: Icon,
  tone,
  pulse,
  loading,
}: {
  label: string
  value: string
  icon: typeof LogIn
  tone: 'emerald' | 'amber' | 'neutral'
  pulse?: boolean
  loading?: boolean
}) {
  const toneClass =
    tone === 'emerald'
      ? 'bg-emerald-100 text-emerald-700'
      : tone === 'amber'
        ? 'bg-amber-100 text-amber-800'
        : 'bg-primary/10 text-primary'
  return (
    <Card className="gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          {loading ? (
            <Skeleton className="h-7 w-16" />
          ) : (
            <p className="flex items-center gap-1.5 text-2xl font-bold leading-none tabular-nums">
              {pulse ? (
                <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" aria-hidden />
              ) : null}
              {value}
            </p>
          )}
        </div>
        <div className={cn('grid size-9 shrink-0 place-items-center rounded-lg', toneClass)}>
          <Icon className="size-4.5" aria-hidden />
        </div>
      </div>
    </Card>
  )
}

// ─── View ───────────────────────────────────────────────────────────

export default function AttendanceView() {
  const { t } = useI18n()

  const [date, setDate] = useState(() => toDateInputValue(new Date()))
  const today = useMemo(() => toDateInputValue(new Date()), [])
  const isToday = date === today

  const attendanceQuery = useQuery({
    queryKey: ['attendance', date],
    queryFn: () => fetcher<AttendanceResponse>(`/api/attendance?date=${date}`),
    refetchInterval: isToday ? 15_000 : false,
  })

  const records = attendanceQuery.data?.records ?? []
  const summary = attendanceQuery.data?.summary
  const loading = attendanceQuery.isLoading

  const totalWorked = useMemo(() => {
    const totalMinutes = summary?.totalWorkedMinutes ?? 0
    const h = Math.floor(totalMinutes / 60)
    const m = totalMinutes % 60
    return t('admin.hoursMinutes', { h, m })
  }, [summary?.totalWorkedMinutes, t])

  function setQuickDate(daysBack: number) {
    setDate(daysBack === 0 ? today : daysAgoInput(daysBack))
  }

  const quickChips: { days: number; label: string; active: boolean }[] = [
    { days: 0, label: t('common.today'), active: date === today },
    { days: 1, label: t('admin.yesterday'), active: date === daysAgoInput(1) },
    { days: 7, label: t('admin.daysAgo', { n: 7 }), active: date === daysAgoInput(7) },
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
            <span className="font-medium text-primary">{t('nav.attendance')}</span>
          </nav>
          <h1 className="text-2xl font-bold tracking-tight">{t('nav.attendance')}</h1>
          <p className="text-sm text-muted-foreground">{t('admin.attendanceSubtitle')}</p>
        </div>
      </div>

      {/* Date picker + quick chips */}
      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <CalendarDays
              className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="date"
              value={date}
              max={today}
              min={daysAgoInput(31)}
              onChange={(e) => setDate(e.target.value)}
              className="h-11 w-44 ps-9"
              aria-label={t('common.date')}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {quickChips.map((chip) => (
              <Button
                key={chip.days}
                variant={chip.active ? 'default' : 'outline'}
                size="sm"
                className="h-11"
                onClick={() => setQuickDate(chip.days)}
              >
                {chip.label}
              </Button>
            ))}
          </div>
          {isToday && !attendanceQuery.isError ? (
            <span className="ms-auto flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" aria-hidden />
              {t('common.live')}
            </span>
          ) : null}
        </div>
      </Card>

      {/* Summary cards */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          label={t('attendance.inNow')}
          value={String(summary?.stillIn ?? 0)}
          icon={LogIn}
          tone="emerald"
          pulse={(summary?.stillIn ?? 0) > 0}
          loading={loading}
        />
        <SummaryCard
          label={t('attendance.late')}
          value={String(summary?.lateCount ?? 0)}
          icon={AlarmClock}
          tone="amber"
          loading={loading}
        />
        <SummaryCard
          label={t('admin.employeesCheckedIn')}
          value={String(summary?.checkedIn ?? 0)}
          icon={UsersRound}
          tone="neutral"
          loading={loading}
        />
        <SummaryCard
          label={t('admin.totalWorkedHours')}
          value={totalWorked}
          icon={Timer}
          tone="neutral"
          loading={loading}
        />
      </div>

      {/* Records table */}
      <Card className="p-4">
        {attendanceQuery.isError ? (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <TriangleAlert className="size-10 text-destructive" aria-hidden />
            <div>
              <p className="font-medium">{t('admin.loadAttendanceFailed')}</p>
              <p className="text-muted-foreground text-sm">
                {attendanceQuery.error?.message ?? t('common.error')}
              </p>
            </div>
            <Button
              variant="outline"
              className="h-11"
              onClick={() => void attendanceQuery.refetch()}
            >
              {t('common.retry')}
            </Button>
          </div>
        ) : loading ? (
          <div className="rms-scroll max-h-[520px] space-y-2 overflow-y-auto">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="flex items-center gap-4 rounded-lg border p-3">
                <Skeleton className="size-9 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-20" />
                </div>
                <Skeleton className="h-4 w-14" />
                <Skeleton className="h-4 w-14" />
                <Skeleton className="h-6 w-20 rounded-full" />
              </div>
            ))}
          </div>
        ) : records.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-12 text-center">
            <CalendarDays className="size-10 text-muted-foreground/50" aria-hidden />
            <div>
              <p className="font-medium">{t('admin.noAttendance')}</p>
              <p className="text-muted-foreground text-sm">{t('admin.noAttendanceHint')}</p>
            </div>
          </div>
        ) : (
          <div className="rms-scroll max-h-[520px] overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow>
                  <TableHead>{t('admin.attendanceEmployee')}</TableHead>
                  <TableHead>{t('attendance.checkIn')}</TableHead>
                  <TableHead>{t('attendance.checkOut')}</TableHead>
                  <TableHead>{t('attendance.worked')}</TableHead>
                  <TableHead>{t('common.status')}</TableHead>
                  <TableHead className="hidden md:table-cell">
                    {t('attendance.shift')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map((r) => {
                  const role = r.user?.role ?? ''
                  const roleLabel =
                    role === 'custom'
                      ? (r.user?.roleName ?? t('role.custom'))
                      : t(`role.${role}`)
                  return (
                    <TableRow key={r.id} className="h-16">
                      <TableCell>
                        <div className="flex items-center gap-3">
                          <Avatar className="size-9">
                            <AvatarFallback
                              className={cn(
                                'text-xs font-semibold',
                                ROLE_AVATAR_CLASS[role] ?? ROLE_AVATAR_CLASS.custom,
                              )}
                            >
                              {initials(r.user?.name ?? '?')}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <div className="truncate font-medium">{r.user?.name ?? '—'}</div>
                            <Badge
                              variant="outline"
                              className={cn('mt-0.5 px-1.5 text-[10px]', ROLE_BADGE_CLASS[role])}
                            >
                              {roleLabel}
                            </Badge>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-sm tabular-nums">
                        {formatTime(r.checkInAt)}
                      </TableCell>
                      <TableCell className="font-mono text-sm tabular-nums">
                        {r.checkOutAt ? (
                          formatTime(r.checkOutAt)
                        ) : (
                          <span className="inline-flex items-center gap-1.5 font-sans font-medium text-emerald-700 dark:text-emerald-400">
                            <span
                              className="h-2 w-2 animate-pulse rounded-full bg-emerald-500"
                              aria-hidden
                            />
                            {t('attendance.inNow')}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="tabular-nums">
                        {r.checkOutAt ? workedDuration(r.checkInAt, r.checkOutAt) : '—'}
                      </TableCell>
                      <TableCell>
                        {r.lateMinutes > 0 ? (
                          <Badge
                            variant="outline"
                            className="border-amber-600/40 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-400"
                          >
                            <Clock className="size-3" aria-hidden />
                            {t('attendance.lateBy', { minutes: r.lateMinutes })}
                          </Badge>
                        ) : (
                          <Badge
                            variant="outline"
                            className="border-emerald-600/30 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-400"
                          >
                            {t('attendance.onTime')}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground md:table-cell">
                        {r.shiftName ?? '—'}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  )
}
