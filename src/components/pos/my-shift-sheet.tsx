'use client'

// R8: "My shift" closeout sheet — a server's day at a glance (sales,
// collected by method, OPEN checks and, most importantly, TIPS earned).
// Standalone component: the main agent mounts it in the POS view with
// { open, onOpenChange } and a launch button (pos.myShift).

import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { HandCoins, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { fetcher } from '@/lib/api'
import { formatCurrency, formatTime } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import type { MyShiftReport } from '@/lib/types'

type MyShiftSheetProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Poll the live report while the sheet is open (30s, like other POS panels). */
const SHIFT_POLL_MS = 30_000

export default function MyShiftSheet({ open, onOpenChange }: MyShiftSheetProps) {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  // p21: the CLOCK-IN state (wall attendance) — "My shift" is the SALES
  // closeout, but the waiter thinks of both as "my shift". Showing the
  // attendance chip here unifies the two concepts: clocked-in servers see
  // their live worked time without going back to the wall.
  const [nowTick, setNowTick] = useState(() => Date.now())
  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => setNowTick(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [open])
  const attendance = useQuery({
    queryKey: ['attendance-me'],
    queryFn: () =>
      fetcher<{ today: { checkInAt: string } | null; onShift: boolean; workedMinutes: number | null }>(
        '/api/attendance/me',
      ),
    enabled: open,
    refetchInterval: open ? 60_000 : false,
  })
  const liveWorked =
    attendance.data?.onShift && attendance.data.today
      ? Math.max(
          0,
          Math.round((nowTick - new Date(attendance.data.today.checkInAt).getTime()) / 60000),
        )
      : attendance.data?.onShift
        ? (attendance.data.workedMinutes ?? 0)
        : null

  const { data, isPending, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ['my-shift'],
    queryFn: () => fetcher<{ report: MyShiftReport }>('/api/reports/my-shift'),
    enabled: open,
    refetchInterval: open ? SHIFT_POLL_MS : false,
  })

  // r70 audit: an in-flight refetch that resolves AFTER the sheet starts
  // its exit animation re-renders rows inside the closing portal — that
  // raced the unmount into an uncaught NotFoundError: removeChild and a
  // full-page crash. Cancel the queries the moment the sheet closes and
  // freeze the last-known report so the exiting subtree stays byte-stable.
  useEffect(() => {
    if (open) return
    void queryClient.cancelQueries({ queryKey: ['my-shift'] })
    void queryClient.cancelQueries({ queryKey: ['attendance-me'] })
  }, [open, queryClient])
  const [frozenReport, setFrozenReport] = useState<MyShiftReport | null>(null)
  // React's documented "adjust state during render" pattern (no effect): the
  // frozen copy tracks the live report while open, then holds it stable for
  // the whole exit animation so the closing portal never re-renders its rows.
  const liveReport = data?.report ?? null
  if (open && liveReport != null && liveReport !== frozenReport) {
    setFrozenReport(liveReport)
  }
  const report = open ? (liveReport ?? frozenReport) : frozenReport

  // Surface fetch errors as a toast; the sheet itself stays mounted.
  useEffect(() => {
    if (isError) {
      toast.error(error instanceof Error ? error.message : t('common.requestFailed'))
    }
  }, [isError, error])

  const loading = open && isPending && !report
  const empty = report != null && report.ordersCount === 0

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[88dvh] overflow-y-auto rounded-t-2xl pb-6 rms-scroll sm:max-h-[80dvh]"
      >
        <SheetHeader className="pb-0">
          <div className="flex items-center justify-between gap-2 pr-10">
            <SheetTitle className="flex items-center gap-2 text-lg">
              <HandCoins className="size-5 text-success" aria-hidden />
              {t('pos.myShift')}
            </SheetTitle>
            <Button
              variant="outline"
              className="h-11 rounded-xl"
              onClick={() => void refetch()}
              disabled={isPending || isRefetching}
              title={t('common.refresh')}
            >
              <RefreshCw className={cn(isRefetching && 'animate-spin')} aria-hidden />
              <span className="hidden sm:inline">{t('common.refresh')}</span>
            </Button>
          </div>
          <SheetDescription>{t('shift.subtitle')}</SheetDescription>
          {/* p21: clock-in state chip — bridges the wall attendance and the
              sales closeout (two halves of "my shift"). */}
          {attendance.data != null && (
            <div className='mt-1 flex items-center gap-2'>
              {attendance.data.onShift ? (
                <span className='inline-flex items-center gap-1.5 rounded-full border border-success/40 bg-success/10 px-3 py-1 text-xs font-semibold text-success'>
                  <span className='relative flex size-2' aria-hidden>
                    <span className='absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60' />
                    <span className='relative inline-flex size-2 rounded-full bg-success' />
                  </span>
                  {t('shift.clockChipOn')}
                  {liveWorked != null && (
                    <span className='tabular-nums' dir='ltr'>
                      · {Math.floor(liveWorked / 60)}h {liveWorked % 60}m
                    </span>
                  )}
                </span>
              ) : (
                <span className='inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-3 py-1 text-xs font-medium text-muted-foreground'>
                  {t('shift.clockChipOff')}
                </span>
              )}
            </div>
          )}
        </SheetHeader>

        <div className="space-y-4 px-4">
          {loading ? (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {Array.from({ length: 6 }, (_, i) => (
                  <Skeleton key={i} className="h-20 rounded-xl" />
                ))}
              </div>
              <Skeleton className="h-28 rounded-xl" />
            </div>
          ) : !report ? null : empty ? (
            <div className="flex h-40 items-center justify-center rounded-xl border border-dashed border-border">
              <p className="px-6 text-center text-sm text-muted-foreground">
                {t('shift.noSales')}
              </p>
            </div>
          ) : (
            <>
              {/* Stat grid — tips get the hero treatment (emerald, big) */}
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <div className="col-span-2 flex items-center justify-between rounded-xl border-2 border-success bg-success/10 p-3 sm:col-span-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-success">
                    {t('shift.tips')}
                  </p>
                  <p className="text-2xl font-bold tabular-nums text-success">
                    {formatCurrency(report.tipsTotal)}
                  </p>
                </div>
                {/* R26: cash to hand over — collected minus change given back */}
                <div className="col-span-2 flex flex-col justify-center gap-1 rounded-xl border-2 border-warning bg-warning/10 p-3 sm:col-span-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-warning">
                      {t('shift.netCash')}
                    </p>
                    <p className="text-2xl font-bold tabular-nums text-warning">
                      {formatCurrency(report.netCash)}
                    </p>
                  </div>
                  <p className="text-xs tabular-nums text-warning">
                    {t('shift.cashCollected')} {formatCurrency(report.cashCollected)} −{' '}
                    {t('shift.changeGiven')} {formatCurrency(report.cashChangeGiven)}
                  </p>
                </div>
                <StatCell label={t('shift.sales')} value={formatCurrency(report.salesTotal)} />
                <StatCell label={t('shift.orders')} value={String(report.ordersCount)} />
                <StatCell label={t('shift.avgCheck')} value={formatCurrency(report.avgCheck)} />
                <StatCell label={t('shift.paidSales')} value={formatCurrency(report.paidTotal)} />
                <StatCell
                  className="col-span-2 sm:col-span-1"
                  label={t('shift.openChecks')}
                  value={String(report.openChecksCount)}
                  sub={`${t('shift.openValue')}: ${formatCurrency(report.openValue)}`}
                />
              </div>

              {/* Collected by method (amount / count / tip) */}
              {report.byMethod.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t('shift.byMethod')}
                  </p>
                  <div className="overflow-hidden rounded-xl border border-border">
                    <Table>
                      <TableHeader>
                        <TableRow className="bg-muted/50 hover:bg-muted/50">
                          <TableHead className="h-11">{t('admin.zreportMethod')}</TableHead>
                          <TableHead className="h-11 text-right">{t('money.total')}</TableHead>
                          <TableHead className="h-11 text-center">#</TableHead>
                          <TableHead className="h-11 text-right text-success">
                            {t('pos.tip')}
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {report.byMethod.map((m) => (
                          <TableRow key={m.method}>
                            <TableCell className="py-3 font-medium">
                              {t(`status.payment.${m.method}`)}
                            </TableCell>
                            <TableCell className="py-3 text-right font-semibold tabular-nums">
                              {formatCurrency(m.amount)}
                            </TableCell>
                            <TableCell className="py-3 text-center text-muted-foreground tabular-nums">
                              {m.count}
                            </TableCell>
                            <TableCell
                              className={cn(
                                'py-3 text-right font-semibold tabular-nums',
                                m.tip > 0 ? 'text-success' : 'text-muted-foreground',
                              )}
                            >
                              {formatCurrency(m.tip)}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}

              {/* r67: the checks themselves — open AND closed, so the server
                  can SEE every check of their shift (the closed ones used to
                  be invisible: userless webhook checks never counted, and
                  old checks closed today were outside the day window). */}
              {report.checks.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t('shift.checks')} · {report.checks.length}
                  </p>
                  <div className="overflow-hidden rounded-xl border border-border">
                    <div className="max-h-72 overflow-y-auto rms-scroll">
                      <Table>
                        <TableHeader>
                          <TableRow className="bg-muted/50 hover:bg-muted/50">
                            <TableHead className="h-10">{t('shift.checkNum')}</TableHead>
                            <TableHead className="h-10 text-right">{t('money.total')}</TableHead>
                            <TableHead className="h-10 text-right text-success">
                              {t('shift.tipCol')}
                            </TableHead>
                            <TableHead className="h-10 text-right">
                              {t('common.status')}
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {report.checks.map((c) => (
                            <TableRow key={c.id}>
                              <TableCell className="py-2.5">
                                <span className="font-semibold tabular-nums">#{c.id}</span>
                                {/* r69: show the SETTLE time for closed checks (the
                                    moment the check became this server's shift
                                    work — createdAt on an older check can read
                                    as an impossible time in this list); open
                                    checks keep their creation time. */}
                                <span className="block text-xs text-muted-foreground">
                                  {formatTime(c.closedAt ?? c.createdAt)}
                                </span>
                              </TableCell>
                              <TableCell className="py-2.5 text-right font-semibold tabular-nums">
                                {formatCurrency(c.total)}
                              </TableCell>
                              <TableCell
                                className={cn(
                                  'py-2.5 text-right tabular-nums',
                                  c.tip > 0 ? 'font-semibold text-success' : 'text-muted-foreground',
                                )}
                              >
                                {formatCurrency(c.tip)}
                              </TableCell>
                              <TableCell className="py-2.5 text-right">
                                <CheckStatusBadge status={c.status} />
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function StatCell({
  label,
  value,
  sub,
  className,
}: {
  label: string
  value: string
  /** small muted second line (e.g. open value under the open-check count) */
  sub?: string
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col justify-center gap-0.5 rounded-xl border border-border bg-card p-3 card-elevated',
        className,
      )}
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="text-lg font-bold tabular-nums">{value}</p>
      {sub && <p className="text-xs text-muted-foreground tabular-nums">{sub}</p>}
    </div>
  )
}

/** r67: compact status badge for a check line (paid = emerald, open =
 *  amber, deferred = stone — the warm palette only, no blue/indigo). */
function CheckStatusBadge({ status }: { status: string }) {
  const { t } = useI18n()
  const tone =
    status === 'paid'
      ? 'border-success/40 bg-success/10 text-success'
      : status === 'open'
        ? 'border-warning/40 bg-warning/10 text-warning'
        : 'border-border bg-muted/60 text-muted-foreground'
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold',
        tone,
      )}
    >
      {t(`status.order.${status}`)}
    </span>
  )
}
