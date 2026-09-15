'use client'

// R8: "My shift" closeout sheet — a server's day at a glance (sales,
// collected by method, OPEN checks and, most importantly, TIPS earned).
// Standalone component: the main agent mounts it in the POS view with
// { open, onOpenChange } and a launch button (pos.myShift).

import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
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
import { formatCurrency } from '@/lib/format'
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

  const { data, isPending, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ['my-shift'],
    queryFn: () => fetcher<{ report: MyShiftReport }>('/api/reports/my-shift'),
    enabled: open,
    refetchInterval: open ? SHIFT_POLL_MS : false,
  })

  // Surface fetch errors as a toast; the sheet itself stays mounted.
  useEffect(() => {
    if (isError) {
      toast.error(error instanceof Error ? error.message : t('common.requestFailed'))
    }
  }, [isError, error])

  const report = data?.report
  const loading = open && isPending
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
              <HandCoins className="size-5 text-emerald-600" aria-hidden />
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
                <div className="col-span-2 flex items-center justify-between rounded-xl border-2 border-emerald-600 bg-emerald-50 p-3 sm:col-span-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">
                    {t('shift.tips')}
                  </p>
                  <p className="text-2xl font-bold tabular-nums text-emerald-700">
                    {formatCurrency(report.tipsTotal)}
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
                          <TableHead className="h-11 text-right text-emerald-700">
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
                                m.tip > 0 ? 'text-emerald-700' : 'text-muted-foreground',
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
        'flex flex-col justify-center gap-0.5 rounded-xl border border-border bg-white p-3',
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
