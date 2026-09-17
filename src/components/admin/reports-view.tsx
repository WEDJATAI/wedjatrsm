'use client'

import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Ban,
  BarChart3,
  Boxes,
  CalendarDays,
  CalendarRange,
  CircleDollarSign,
  Dog,
  Flame,
  HandCoins,
  Hourglass,
  Info,
  Lightbulb,
  Percent,
  Printer,
  Receipt,
  ReceiptText,
  Star,
  TrendingUp,
  Undo2,
  Users,
  Wallet,
} from 'lucide-react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { apiFetch, fetcher } from '@/lib/api'
import type {
  InventoryValueReport,
  MenuEngineeringReport,
  Order,
  SalesReport,
  SessionUser,
  ZReport,
} from '@/lib/types'
import {
  formatCurrency,
  formatDate,
  formatDateTime,
  formatLocale,
  toDateInputValue,
} from '@/lib/format'
import { localizedName, useI18n } from '@/lib/i18n'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
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
import { escapeHtml } from '@/components/pos/pos-utils'
import { useAppSettings } from '@/lib/use-settings'

function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return toDateInputValue(d)
}

function parseDay(value: string): Date {
  // 'YYYY-MM-DD' parsed as local midnight (avoids UTC off-by-one)
  return new Date(`${value}T00:00:00`)
}

function dayLocale(): string {
  return formatLocale() === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB'
}

function shortDay(dateStr: string): string {
  return parseDay(dateStr).toLocaleDateString(dayLocale(), {
    day: '2-digit',
    month: 'short',
  })
}

function compactFormatter(): Intl.NumberFormat {
  return new Intl.NumberFormat(dayLocale(), {
    notation: 'compact',
    maximumFractionDigits: 1,
  })
}

function axisEGP(value: number): string {
  return formatLocale() === 'ar'
    ? `${compactFormatter().format(value)} ج.م`
    : `E£${compactFormatter().format(value)}`
}

const PIE_PALETTE = ['#d97706', '#f59e0b', '#059669', '#a8a29e', '#e11d48', '#78716c']
const GRID_STROKE = '#e7e5e4'
const TICK_STYLE = { fontSize: 12, fill: '#78716c' }

// ─── Chart tooltip (recharts content element) ──────────────────────

type TooltipEntry = {
  name?: string | number
  value?: string | number
  payload?: Record<string, unknown> & { orders?: number; quantity?: number }
}

function ChartTooltip({
  active,
  payload,
  label,
  detail,
}: {
  active?: boolean
  payload?: TooltipEntry[]
  label?: string | number
  detail?: (entry: TooltipEntry) => string
}) {
  if (!active || !payload || payload.length === 0) return null
  return (
    <div className="rounded-lg border bg-popover px-3 py-2 text-xs shadow-md">
      {label != null && label !== '' ? <p className="mb-1 font-medium">{label}</p> : null}
      {payload.map((entry, i) => (
        <p key={i} className="text-muted-foreground">
          <span>{entry.name}: </span>
          <span className="font-medium text-foreground">
            {formatCurrency(Number(entry.value ?? 0))}
          </span>
          {detail ? <span>{detail(entry)}</span> : null}
        </p>
      ))}
    </div>
  )
}

// ─── Chart card wrapper ────────────────────────────────────────────

function ChartCard({
  title,
  description,
  empty,
  emptyLabel,
  children,
}: {
  title: string
  description?: string
  empty?: boolean
  emptyLabel: string
  children: ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>
        {empty ? (
          <div className="flex h-[280px] flex-col items-center justify-center gap-2 text-center">
            <BarChart3 className="size-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">{emptyLabel}</p>
          </div>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  )
}

// ─── Z-Report (end-of-day reconciliation) ─────────────────────

function todayLocal(): string {
  return toDateInputValue(new Date())
}

type Translate = (key: string, vars?: Record<string, string | number>) => string

/** Build the printable Z-Report paper. Same print mechanism as the POS
 *  receipt/check modals: thermal monospace, 320px, dashed rules, flex rows. */
function buildZReportHtml(
  report: ZReport,
  t: Translate,
  restaurantName: string,
  restaurantNameAr: string,
): string {
  const row = (l: string, r: string, cls = '') =>
    `<div class="r ${cls}"><span>${escapeHtml(l)}</span><span>${escapeHtml(r)}</span></div>`
  const dashed = '<div class="dashed"></div>'
  const section = (title: string) => `<p class="sec">${escapeHtml(title)}</p>`

  const lines: string[] = []
  lines.push(`<h3>${escapeHtml(restaurantName)}</h3>`)
  lines.push(`<p class="arn" dir="rtl">${escapeHtml(restaurantNameAr)}</p>`)
  lines.push(`<p>${escapeHtml(t('admin.zreportTitle'))}</p>`)
  lines.push(dashed)
  lines.push(row(t('admin.zreportDate'), formatDate(parseDay(report.date))))
  lines.push(dashed)
  lines.push(row(t('admin.zreportOrdersClosed'), String(report.ordersClosed)))
  lines.push(row(t('admin.zreportCovers'), String(report.covers)))
  lines.push(row(t('admin.zreportGross'), formatCurrency(report.grossSubtotal)))
  lines.push(row(t('admin.zreportDiscounts'), formatCurrency(report.discounts)))
  lines.push(row(t('admin.zreportVat'), formatCurrency(report.vat)))
  lines.push(row(t('admin.zreportService'), formatCurrency(report.serviceTax)))
  lines.push(row(t('admin.zreportNet'), formatCurrency(report.netTotal), 'bold'))
  lines.push(row(t('admin.zreportAvgCheck'), formatCurrency(report.avgCheck)))
  lines.push(row(t('admin.zreportCancelled'), String(report.cancelledCount)))
  lines.push(dashed)
  lines.push(section(t('admin.zreportPayments')))
  for (const m of report.paymentsByMethod) {
    lines.push(row(`${t(`status.payment.${m.method}`)} (${m.count})`, formatCurrency(m.amount)))
  }
  if (report.paymentsByMethod.length === 0) lines.push('<p class="muted">—</p>')
  lines.push(
    row(
      t('admin.zreportPaymentsTotal'),
      formatCurrency(report.paymentsTotal),
      'bold',
    ),
  )
  // R17: refunds issued this day (negative payments) — only when any exist
  if (report.refunds && report.refunds.count > 0) {
    lines.push(
      row(
        `${t('r17.refund.zreportLine')} (${report.refunds.count})`,
        formatCurrency(report.refunds.total),
      ),
    )
  }
  lines.push(dashed)
  lines.push(row(t('admin.zreportDeferredSettled'), formatCurrency(report.deferredSettled)))
  lines.push(row(t('admin.zreportDeferredOutstanding'), formatCurrency(report.deferredOutstanding)))
  lines.push(dashed)
  lines.push(section(t('admin.zreportByWaiter')))
  for (const w of report.byWaiter) {
    lines.push(row(`${w.name} (${w.orders})`, formatCurrency(w.net)))
  }
  if (report.byWaiter.length === 0) lines.push('<p class="muted">—</p>')
  return lines.join('\n')
}

/** R17: Refunds — issue manager-approved refunds against paid checks.
 *  A refund is a negative payment row (reference `refund: <reason>`);
 *  the Z-report nets it automatically for the day it left the drawer. */
function RefundSection() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [target, setTarget] = useState<Order | null>(null)
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const [method, setMethod] = useState('cash')

  // Refunds are an admin-only action (matches the API guard) — hide the
  // section entirely for non-admin report viewers.
  const sessionQuery = useQuery({
    queryKey: ['session'],
    queryFn: () => fetcher<{ user: SessionUser }>('/api/auth/me'),
    staleTime: 60_000,
  })
  const isAdmin = sessionQuery.data?.user.role === 'admin'

  const paidQuery = useQuery({
    queryKey: ['orders', 'paid'],
    enabled: isAdmin === true,
    queryFn: () => fetcher<{ orders: Order[] }>('/api/orders?status=paid'),
    staleTime: 15_000,
  })

  const recent = useMemo(
    () =>
      [...(paidQuery.data?.orders ?? [])]
        .sort((a, b) => (b.closedAt ?? b.createdAt).localeCompare(a.closedAt ?? a.createdAt))
        .slice(0, 12),
    [paidQuery.data],
  )

  const refundMutation = useMutation({
    mutationFn: (input: { orderId: number; amount: number; reason: string; method: string }) =>
      apiFetch<{
        refundedTotal: number
        remainingCapacity: number
      }>(`/api/orders/${input.orderId}/refund`, {
        method: 'POST',
        body: { amount: input.amount, reason: input.reason, method: input.method },
      }),
    onSuccess: (data) => {
      toast.success(
        t('r17.refund.issued', {
          amount: formatCurrency(target ? Number(amount) : 0),
          order: target?.id ?? 0,
        }),
      )
      setTarget(null)
      setAmount('')
      setReason('')
      void queryClient.invalidateQueries({ queryKey: ['orders', 'paid'] })
      void queryClient.invalidateQueries({ queryKey: ['zreport'] })
      void queryClient.invalidateQueries({ queryKey: ['sales-report'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  if (sessionQuery.isLoading || !isAdmin) return null

  function openRefund(order: Order) {
    let paid = 0
    let refunded = 0
    for (const p of order.payments ?? []) {
      if (p.amount >= 0) paid += p.amount
      else refunded += -p.amount
    }
    const capacity = Math.round((paid - refunded) * 100) / 100
    setTarget(order)
    setAmount(capacity > 0 ? String(capacity) : '')
    setReason('')
    setMethod(
      [...(order.payments ?? [])].filter((p) => p.amount > 0).sort((a, b) => b.amount - a.amount)[0]
        ?.method ?? 'cash',
    )
  }

  function submitRefund() {
    if (target == null) return
    const value = Math.round(Number(amount) * 100) / 100
    if (!Number.isFinite(value) || value <= 0) {
      toast.error(t('r17.refund.needAmount'))
      return
    }
    let paid = 0
    let refunded = 0
    for (const p of target.payments ?? []) {
      if (p.amount >= 0) paid += p.amount
      else refunded += -p.amount
    }
    const capacity = Math.round((paid - refunded) * 100) / 100
    if (value > capacity) {
      toast.error(t('r17.refund.exceeds', { amount: formatCurrency(capacity) }))
      return
    }
    if (!reason.trim()) {
      toast.error(t('r17.refund.needReason'))
      return
    }
    refundMutation.mutate({ orderId: target.id, amount: value, reason: reason.trim(), method })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Undo2 className="size-5 text-rose-600" aria-hidden />
          {t('r17.refund.title')}
        </CardTitle>
        <CardDescription>{t('r17.refund.subtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {paidQuery.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : paidQuery.isError ? (
          <div className="flex flex-col items-center gap-2 py-6">
            <p className="text-sm text-muted-foreground">{t('r17.common.error')}</p>
            <Button variant="outline" size="sm" onClick={() => void paidQuery.refetch()}>
              {t('r17.common.retry')}
            </Button>
          </div>
        ) : recent.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {t('r17.refund.noOrders')}
          </p>
        ) : (
          <div className="max-h-96 overflow-y-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('r17.refund.order')}</TableHead>
                  <TableHead>{t('r17.refund.closed')}</TableHead>
                  <TableHead className="text-end">{t('r17.refund.paid')}</TableHead>
                  <TableHead className="text-end">{t('r17.refund.refunded')}</TableHead>
                  <TableHead className="text-end">{t('r17.refund.remaining')}</TableHead>
                  <TableHead className="w-10" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.map((order) => {
                  let paid = 0
                  let refunded = 0
                  for (const p of order.payments ?? []) {
                    if (p.amount >= 0) paid += p.amount
                    else refunded += -p.amount
                  }
                  const capacity = Math.round((paid - refunded) * 100) / 100
                  return (
                    <TableRow key={order.id}>
                      <TableCell className="font-medium">#{order.id}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDateTime(order.closedAt ?? order.createdAt)}
                      </TableCell>
                      <TableCell className="text-end">{formatCurrency(paid)}</TableCell>
                      <TableCell className="text-end">
                        {refunded > 0 ? (
                          <span className="text-rose-600">−{formatCurrency(refunded)}</span>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell className="text-end">
                        {capacity > 0 ? (
                          formatCurrency(capacity)
                        ) : (
                          <Badge variant="secondary">{t('r17.refund.alreadyRefunded')}</Badge>
                        )}
                      </TableCell>
                      <TableCell>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={capacity <= 0}
                          aria-label={`${t('r17.refund.issue')} #${order.id}`}
                          onClick={() => openRefund(order)}
                        >
                          {t('r17.refund.issue')}
                        </Button>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      {/* Refund dialog */}
      <Dialog open={target != null} onOpenChange={(open) => !open && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('r17.refund.issue')} · #{target?.id}
            </DialogTitle>
            <DialogDescription>{t('r17.refund.subtitle')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="refund-amount">{t('r17.refund.amount')}</Label>
              <Input
                id="refund-amount"
                type="number"
                min="0"
                step="0.5"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="refund-method">{t('r17.refund.method')}</Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger id="refund-method" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">{t('status.payment.cash')}</SelectItem>
                  <SelectItem value="card">{t('status.payment.card')}</SelectItem>
                  <SelectItem value="other">{t('status.payment.other')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="refund-reason">{t('r17.refund.reason')}</Label>
              <Input
                id="refund-reason"
                value={reason}
                maxLength={140}
                placeholder={t('r17.refund.reasonPlaceholder')}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)}>
              {t('r17.common.cancel')}
            </Button>
            <Button onClick={submitRefund} disabled={refundMutation.isPending}>
              {refundMutation.isPending ? t('common.loading') : t('r17.refund.issue')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}

/** One KPI tile of the Z-Report grid (mirrors the view's KPI card markup). */
function ZKpi({
  label,
  value,
  icon,
  emphasized,
}: {
  label: string
  value: string
  icon: ReactNode
  emphasized?: boolean
}) {
  return (
    <Card className="gap-2 p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{label}</p>
        {icon}
      </div>
      <p
        className={`text-2xl font-bold tabular-nums ${emphasized ? 'text-primary' : ''}`}
      >
        {value}
      </p>
    </Card>
  )
}

function ZReportSection() {
  const { t, lang, isRTL } = useI18n()
  const { restaurantName, restaurantNameAr } = useAppSettings()
  // report is fetched manually: draft date in state, submitted date drives the query
  const [date, setDate] = useState(todayLocal)
  const [queryDate, setQueryDate] = useState<string | null>(null)

  const zreportQuery = useQuery({
    queryKey: ['zreport', queryDate],
    enabled: queryDate != null,
    queryFn: () => fetcher<{ report: ZReport }>(`/api/reports/zreport?date=${queryDate}`),
  })

  const report = zreportQuery.data?.report
  const noData = report != null && report.ordersClosed === 0 && report.paymentsTotal === 0
  const paymentsCount = (report?.paymentsByMethod ?? []).reduce((sum, m) => sum + m.count, 0)
  // R8: gratuity totals — 0 is a valid value (renders until the Z route
  // aggregates real tips); per-method lines only when a method took tips.
  const tips = report?.tips ?? { total: 0, cash: 0, card: 0, other: 0 }
  const tipMethods = (['cash', 'card', 'other'] as const).filter((m) => tips[m] > 0)

  function handlePrint() {
    if (!report) return
    const html = buildZReportHtml(report, t, restaurantName, restaurantNameAr)
    const w = window.open('', '_blank', 'width=380,height=760')
    if (!w) {
      window.alert(t('pos.receiptPopupBlocked'))
      return
    }
    w.document.write(
      `<html dir="${isRTL ? 'rtl' : 'ltr'}" lang="${lang}"><head><meta charset="utf-8"><title>${escapeHtml(
        t('admin.zreportTitle'),
      )}</title><style>body{font-family:monospace;font-size:13px;padding:24px;width:320px} .r{display:flex;justify-content:space-between} .dashed{border-top:1px dashed #000;margin:8px 0} h3,p{margin:2px 0;text-align:center} .sec{font-weight:bold;margin:6px 0 2px} .muted{color:#555} .bold{font-weight:bold} .arn{font-weight:bold;direction:rtl;margin:2px 0}</style></head><body>${html}</body></html>`,
    )
    w.document.close()
    w.focus()
    w.print()
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('admin.zreportTitle')}</CardTitle>
        <CardDescription>{t('admin.zreportSubtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Controls: date + load + print (print only once loaded) */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="zreport-date" className="text-xs text-muted-foreground">
              {t('admin.zreportDate')}
            </Label>
            <Input
              id="zreport-date"
              type="date"
              value={date}
              max={todayLocal()}
              onChange={(e) => setDate(e.target.value)}
              className="w-40"
            />
          </div>
          <Button
            className="h-11"
            onClick={() => setQueryDate(date)}
            disabled={zreportQuery.isFetching}
          >
            <CalendarDays />
            {t('admin.zreportLoad')}
          </Button>
          {report ? (
            <Button variant="outline" className="h-11" onClick={handlePrint}>
              <Printer />
              {t('admin.zreportPrint')}
            </Button>
          ) : null}
        </div>

        {zreportQuery.isError ? (
          <div className="flex flex-col items-start gap-3 py-2">
            <p className="text-sm text-rose-600">
              {(zreportQuery.error as Error | null)?.message ?? t('admin.zreportLoadFailed')}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void zreportQuery.refetch()}
            >
              {t('common.retry')}
            </Button>
          </div>
        ) : zreportQuery.isFetching && !report ? (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {Array.from({ length: 8 }, (_, i) => (
                <Skeleton key={i} className="h-24 rounded-xl" />
              ))}
            </div>
            <Skeleton className="h-40 w-full rounded-xl" />
          </div>
        ) : report ? (
          <div className="space-y-6">
            {noData ? (
              <p className="text-sm text-muted-foreground">{t('admin.zreportNoData')}</p>
            ) : null}

            {/* Day KPIs */}
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              <ZKpi
                label={t('admin.zreportOrdersClosed')}
                value={String(report.ordersClosed)}
                icon={<Receipt className="size-5 text-muted-foreground" />}
              />
              <ZKpi
                label={t('admin.zreportCovers')}
                value={String(report.covers)}
                icon={<Users className="size-5 text-primary" />}
              />
              <ZKpi
                label={t('admin.zreportGross')}
                value={formatCurrency(report.grossSubtotal)}
                icon={<TrendingUp className="size-5 text-emerald-600" />}
              />
              <ZKpi
                label={t('admin.zreportDiscounts')}
                value={formatCurrency(report.discounts)}
                icon={<Percent className="size-5 text-amber-600" />}
              />
              <ZKpi
                label={t('admin.zreportVat')}
                value={formatCurrency(report.vat)}
                icon={<ReceiptText className="size-5 text-muted-foreground" />}
              />
              <ZKpi
                label={t('admin.zreportService')}
                value={formatCurrency(report.serviceTax)}
                icon={<HandCoins className="size-5 text-muted-foreground" />}
              />
              <ZKpi
                label={t('admin.zreportNet')}
                value={formatCurrency(report.netTotal)}
                icon={<CircleDollarSign className="size-5 text-emerald-600" />}
                emphasized
              />
              <ZKpi
                label={t('admin.zreportAvgCheck')}
                value={formatCurrency(report.avgCheck)}
                icon={<Wallet className="size-5 text-amber-600" />}
              />
              <ZKpi
                label={t('admin.zreportCancelled')}
                value={String(report.cancelledCount)}
                icon={<Ban className="size-5 text-rose-600" />}
              />
              {report.refunds && report.refunds.count > 0 ? (
                <ZKpi
                  label={t('r17.refund.zreportLine')}
                  value={formatCurrency(report.refunds.total)}
                  icon={<Undo2 className="size-5 text-rose-600" />}
                />
              ) : null}
            </div>

            {/* Payments by method + deferred chips · Sales by waiter */}
            <div className="grid gap-4 lg:grid-cols-2">
              <Card className="min-w-0 gap-2 p-4">
                <p className="text-sm font-semibold">{t('admin.zreportPayments')}</p>
                {report.paymentsByMethod.length === 0 ? (
                  <p className="py-4 text-center text-sm text-muted-foreground">—</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('admin.zreportMethod')}</TableHead>
                        <TableHead className="text-end">{t('admin.zreportCount')}</TableHead>
                        <TableHead className="text-end">{t('money.total')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {report.paymentsByMethod.map((m) => (
                        <TableRow key={m.method}>
                          <TableCell className="font-medium">
                            {t(`status.payment.${m.method}`)}
                          </TableCell>
                          <TableCell className="text-end tabular-nums">{m.count}</TableCell>
                          <TableCell className="text-end tabular-nums">
                            {formatCurrency(m.amount)}
                          </TableCell>
                        </TableRow>
                      ))}
                      <TableRow className="bg-muted/50 font-semibold">
                        <TableCell>{t('admin.zreportPaymentsTotal')}</TableCell>
                        <TableCell className="text-end tabular-nums">{paymentsCount}</TableCell>
                        <TableCell className="text-end tabular-nums">
                          {formatCurrency(report.paymentsTotal)}
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                )}
                {/* Deferred (pay-later) reconciliation chips */}
                <div className="flex flex-wrap gap-3 border-t pt-4">
                  <div className="flex items-center gap-2 rounded-xl border border-violet-300 bg-violet-50 px-3 py-2 text-violet-900">
                    <Hourglass className="size-4 shrink-0 text-violet-500" aria-hidden />
                    <div>
                      <p className="text-xs font-medium">{t('admin.zreportDeferredSettled')}</p>
                      <p className="text-sm font-bold tabular-nums">
                        {formatCurrency(report.deferredSettled)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 rounded-xl border border-violet-300 bg-violet-50 px-3 py-2 text-violet-900">
                    <Hourglass className="size-4 shrink-0 text-violet-500" aria-hidden />
                    <div>
                      <p className="text-xs font-medium">{t('admin.zreportDeferredOutstanding')}</p>
                      <p className="text-sm font-bold tabular-nums">
                        {formatCurrency(report.deferredOutstanding)}
                      </p>
                    </div>
                  </div>
                </div>

                {/* R8: tips for the day (total + per method when any) */}
                <div className="flex flex-wrap items-center gap-3 border-t pt-4">
                  <div className="flex items-center gap-2 rounded-xl border border-emerald-300 bg-emerald-50 px-3 py-2 text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-400">
                    <HandCoins className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
                    <div>
                      <p className="text-xs font-medium">{t('admin.tipsTotal')}</p>
                      <p className="text-sm font-bold tabular-nums">
                        {formatCurrency(tips.total)}
                      </p>
                    </div>
                  </div>
                  {tipMethods.length > 0 ? (
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <p className="text-xs font-medium text-muted-foreground">
                        {t('admin.tipsByMethod')}
                      </p>
                      {tipMethods.map((m) => (
                        <p key={m} className="flex items-center justify-between gap-3 text-sm">
                          <span className="text-muted-foreground">
                            {t(`status.payment.${m}`)}
                          </span>
                          <span className="font-medium tabular-nums">
                            {formatCurrency(tips[m])}
                          </span>
                        </p>
                      ))}
                    </div>
                  ) : null}
                </div>
              </Card>

              <Card className="min-w-0 gap-2 p-4">
                <p className="text-sm font-semibold">{t('admin.zreportByWaiter')}</p>
                {report.byWaiter.length === 0 ? (
                  <p className="py-4 text-center text-sm text-muted-foreground">—</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('common.name')}</TableHead>
                        <TableHead className="text-end">{t('admin.zreportWaiterOrders')}</TableHead>
                        <TableHead className="text-end">{t('money.revenue')}</TableHead>
                        <TableHead className="text-end">{t('admin.tipsTotal')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {report.byWaiter.map((w) => (
                        <TableRow key={w.userId ?? `user-${w.name}`}>
                          <TableCell className="font-medium">{w.name}</TableCell>
                          <TableCell className="text-end tabular-nums">{w.orders}</TableCell>
                          <TableCell className="text-end tabular-nums">
                            {formatCurrency(w.net)}
                          </TableCell>
                          <TableCell className="text-end tabular-nums">
                            {formatCurrency(w.tips ?? 0)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </Card>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}

// ─── Menu engineering (Kasavana-Smith quadrants, R8) ───────────────

const MENU_ENG_PERIODS = [7, 30, 90] as const

type Classification = MenuEngineeringReport['items'][number]['classification']

const CLASS_LABEL: Record<Classification, string> = {
  star: 'admin.stars',
  plowhorse: 'admin.plowhorses',
  puzzle: 'admin.puzzles',
  dog: 'admin.dogs',
}

const CLASS_CHIP_CLASS: Record<Classification, string> = {
  star: 'border-amber-600/40 bg-amber-50 text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-400',
  plowhorse:
    'border-emerald-600/40 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-400',
  puzzle: 'border-primary/40 bg-primary/10 text-primary',
  dog: 'border-rose-600/40 bg-rose-50 text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-400',
}

function MenuEngineeringSection() {
  const { t, lang } = useI18n()
  const [days, setDays] = useState<number>(7)

  const menuEngQuery = useQuery({
    queryKey: ['menu-engineering', days],
    queryFn: () =>
      fetcher<{ report: MenuEngineeringReport }>(`/api/reports/menu-engineering?days=${days}`),
  })

  const report = menuEngQuery.data?.report
  const items = report?.items ?? []

  const counts = useMemo(() => {
    const c: Record<Classification, number> = { star: 0, plowhorse: 0, puzzle: 0, dog: 0 }
    for (const item of items) c[item.classification] += 1
    return c
  }, [items])

  const quadrants: {
    key: Classification
    label: string
    desc: string
    icon: typeof Star
    iconClass: string
    borderClass: string
  }[] = [
    {
      key: 'star',
      label: t('admin.stars'),
      desc: t('admin.starsDesc'),
      icon: Star,
      iconClass: 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400',
      borderClass: 'border-amber-500/40',
    },
    {
      key: 'plowhorse',
      label: t('admin.plowhorses'),
      desc: t('admin.plowDesc'),
      icon: Flame,
      iconClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-400',
      borderClass: 'border-emerald-600/30',
    },
    {
      key: 'puzzle',
      label: t('admin.puzzles'),
      desc: t('admin.puzzleDesc'),
      icon: Lightbulb,
      iconClass: 'bg-primary/15 text-primary',
      borderClass: 'border-primary/30',
    },
    {
      key: 'dog',
      label: t('admin.dogs'),
      desc: t('admin.dogsDesc'),
      icon: Dog,
      iconClass: 'bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-400',
      borderClass: 'border-rose-600/30',
    },
  ]

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('admin.menuEngTitle')}</CardTitle>
        <CardDescription>{t('admin.menuEngSubtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Period chips + menu averages */}
        <div className="flex flex-wrap items-center gap-2">
          {MENU_ENG_PERIODS.map((p) => (
            <Button
              key={p}
              variant={days === p ? 'default' : 'outline'}
              size="sm"
              className="h-9"
              onClick={() => setDays(p)}
            >
              {t('admin.daysAgo', { n: p })}
            </Button>
          ))}
          {report ? (
            <p className="ms-auto text-xs text-muted-foreground tabular-nums">
              {t('admin.soldQty')}: {report.totalSoldQty} · {t('money.margin')}:{' '}
              {Math.round(report.avgMargin * 100)}% · {t('admin.popularity')}:{' '}
              {(report.avgPopularity * 100).toFixed(1)}%
            </p>
          ) : null}
        </div>

        {menuEngQuery.isError ? (
          <div className="flex flex-col items-start gap-3 py-2">
            <p className="text-sm text-rose-600">
              {(menuEngQuery.error as Error | null)?.message ?? t('common.error')}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void menuEngQuery.refetch()}
            >
              {t('common.retry')}
            </Button>
          </div>
        ) : menuEngQuery.isLoading ? (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-24 rounded-xl" />
              ))}
            </div>
            <Skeleton className="h-64 w-full rounded-xl" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex h-[240px] flex-col items-center justify-center gap-2 text-center">
            <BarChart3 className="size-8 text-muted-foreground/40" aria-hidden />
            <p className="text-sm text-muted-foreground">{t('admin.menuEngEmpty')}</p>
          </div>
        ) : (
          <>
            {/* Quadrant summary — 2×2 on sm+ */}
            <div className="grid gap-4 sm:grid-cols-2">
              {quadrants.map((q) => (
                <div
                  key={q.key}
                  className={`flex items-start gap-3 rounded-xl border ${q.borderClass} p-4`}
                >
                  <div className={`grid size-9 shrink-0 place-items-center rounded-lg ${q.iconClass}`}>
                    <q.icon className="size-4.5" aria-hidden />
                  </div>
                  <div className="min-w-0 space-y-0.5">
                    <p className="flex items-baseline gap-2">
                      <span className="text-2xl font-bold leading-none tabular-nums">
                        {counts[q.key]}
                      </span>
                      <span className="text-sm font-semibold">{q.label}</span>
                    </p>
                    <p className="text-xs text-muted-foreground">{q.desc}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* Item table */}
            <div className="rms-scroll max-h-96 overflow-auto rounded-xl border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">{t('common.name')}</TableHead>
                    <TableHead className="text-end text-xs">{t('admin.soldQty')}</TableHead>
                    <TableHead className="text-end text-xs">{t('money.revenue')}</TableHead>
                    <TableHead className="text-end text-xs">{t('money.profit')}</TableHead>
                    <TableHead className="text-end text-xs">{t('money.margin')}</TableHead>
                    <TableHead className="text-end text-xs">{t('admin.popularity')}</TableHead>
                    <TableHead className="text-xs">{t('admin.classification')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <TableRow key={item.productId}>
                      <TableCell className="max-w-56">
                        <p className="truncate font-medium">
                          {localizedName(item.name, item.nameAr, lang)}
                        </p>
                        {lang === 'en' && (item.nameAr ?? '').trim() ? (
                          <p className="truncate text-xs text-muted-foreground" dir="rtl">
                            {item.nameAr}
                          </p>
                        ) : lang === 'ar' && item.name !== localizedName(item.name, item.nameAr, lang) ? (
                          <p className="truncate text-xs text-muted-foreground">{item.name}</p>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-end tabular-nums">{item.soldQty}</TableCell>
                      <TableCell className="text-end tabular-nums">
                        {formatCurrency(item.revenue)}
                      </TableCell>
                      <TableCell className="text-end tabular-nums">
                        {formatCurrency(item.profit)}
                      </TableCell>
                      <TableCell className="text-end tabular-nums">
                        {Math.round(item.margin * 100)}%
                      </TableCell>
                      <TableCell className="text-end tabular-nums">
                        {(item.popularity * 100).toFixed(1)}%
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={`whitespace-nowrap ${CLASS_CHIP_CLASS[item.classification]}`}
                        >
                          {t(CLASS_LABEL[item.classification])}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}

        <p className="text-xs text-muted-foreground">{t('admin.quadrantHint')}</p>
      </CardContent>
    </Card>
  )
}

// ─── Reports view ──────────────────────────────────────────────────

export default function ReportsView() {
  const { t } = useI18n()
  const [draftFrom, setDraftFrom] = useState(() => daysAgo(6))
  const [draftTo, setDraftTo] = useState(() => toDateInputValue(new Date()))
  const [range, setRange] = useState(() => ({
    from: daysAgo(6),
    to: toDateInputValue(new Date()),
  }))

  const salesQuery = useQuery({
    queryKey: ['sales-report', range.from, range.to],
    queryFn: () =>
      fetcher<SalesReport>(`/api/reports/sales?from=${range.from}&to=${range.to}`),
  })
  const inventoryValueQuery = useQuery({
    queryKey: ['inventory-value'],
    queryFn: () => fetcher<InventoryValueReport>('/api/reports/inventory-value'),
  })

  const report = salesQuery.data
  const noSales = report != null && report.totalOrders === 0

  const byDay = useMemo(
    () => (report?.byDay ?? []).map((d) => ({ ...d, label: shortDay(d.date) })),
    [report],
  )
  const byHour = useMemo(
    () =>
      (report?.byHour ?? []).map((h) => ({
        ...h,
        label: formatLocale() === 'ar' ? `${h.hour} س` : `${h.hour}h`,
      })),
    [report],
  )
  const topProducts = report?.topProducts ?? []
  const byCategory = report?.byCategory ?? []
  const byMethod = report?.byMethod ?? []
  const methodTotal = byMethod.reduce((sum, m) => sum + m.amount, 0)

  function applyRange() {
    if (draftFrom > draftTo) {
      toast.error(t('admin.rangeError'))
      return
    }
    setRange({ from: draftFrom, to: draftTo })
  }

  /** days=1 → today, days=7 → last 7 days, days=30 → last 30 days */
  function applyQuickRange(days: number) {
    const to = toDateInputValue(new Date())
    const from = daysAgo(days - 1)
    setDraftFrom(from)
    setDraftTo(to)
    setRange({ from, to })
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">{t('nav.reports')}</h1>
        <p className="text-sm text-muted-foreground">{t('admin.reportsSubtitle')}</p>
      </div>

      {/* Date range */}
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="report-from" className="text-xs text-muted-foreground">
              {t('admin.from')}
            </Label>
            <Input
              id="report-from"
              type="date"
              value={draftFrom}
              max={draftTo}
              onChange={(e) => setDraftFrom(e.target.value)}
              className="w-40"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="report-to" className="text-xs text-muted-foreground">
              {t('admin.to')}
            </Label>
            <Input
              id="report-to"
              type="date"
              value={draftTo}
              min={draftFrom}
              max={toDateInputValue(new Date())}
              onChange={(e) => setDraftTo(e.target.value)}
              className="w-40"
            />
          </div>
          <Button onClick={applyRange} disabled={salesQuery.isFetching}>
            <CalendarRange />
            {t('common.apply')}
          </Button>
          <div className="ms-auto flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => applyQuickRange(1)}>
              {t('common.today')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => applyQuickRange(7)}>
              {t('admin.last7')}
            </Button>
            <Button variant="outline" size="sm" onClick={() => applyQuickRange(30)}>
              {t('admin.last30')}
            </Button>
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {t('admin.showingRange', {
            from: formatDate(parseDay(range.from)),
            to: formatDate(parseDay(range.to)),
          })}
          {report ? ` · ${t('admin.paidOrders', { count: report.totalOrders })}` : ''}
        </p>
      </Card>

      {/* KPI row */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {salesQuery.isLoading ? (
          Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)
        ) : (
          <>
            <Card className="gap-2 p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">{t('admin.totalRevenue')}</p>
                <TrendingUp className="size-5 text-emerald-600" />
              </div>
              <p className="text-2xl font-bold">
                {formatCurrency(report?.totalRevenue ?? 0)}
              </p>
            </Card>
            <Card className="gap-2 p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">{t('money.orders')}</p>
                <Receipt className="size-5 text-muted-foreground" />
              </div>
              <p className="text-2xl font-bold">{report?.totalOrders ?? 0}</p>
            </Card>
            <Card className="gap-2 p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">{t('money.avgOrderValue')}</p>
                <Wallet className="size-5 text-amber-600" />
              </div>
              <p className="text-2xl font-bold">
                {formatCurrency(report?.avgOrderValue ?? 0)}
              </p>
            </Card>
            <Card className="gap-2 p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">{t('money.avgCheckPerPerson')}</p>
                <Users className="size-5 text-primary" />
              </div>
              <p className="text-2xl font-bold">
                {formatCurrency(report?.avgCheckPerPerson ?? 0)}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('admin.guestsSub', { count: report?.totalGuests ?? 0 })}
              </p>
            </Card>
            {/* Deferred (pay-later) checks outstanding — not revenue until settled */}
            <Card className="gap-2 p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground">{t('reports.deferredOutstanding')}</p>
                <Hourglass className="size-5 text-violet-600" aria-hidden />
              </div>
              <p className="text-2xl font-bold">
                {formatCurrency(report?.deferredOutstanding ?? 0)}
              </p>
              <p
                className="flex items-center gap-1 text-xs text-muted-foreground"
                title={t('reports.deferredHint')}
              >
                <Info className="size-3.5 shrink-0" aria-hidden />
                {t('reports.deferredCount', { n: report?.deferredCount ?? 0 })}
              </p>
            </Card>
          </>
        )}
      </div>

      {/* Charts */}
      <div className="grid gap-4 lg:grid-cols-2">
        {salesQuery.isLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Card key={i}>
              <CardHeader>
                <Skeleton className="h-5 w-40" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-[280px] w-full rounded-lg" />
              </CardContent>
            </Card>
          ))
        ) : salesQuery.isError ? (
          <Card className="lg:col-span-2">
            <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
              <p className="text-sm text-rose-600">
                {(salesQuery.error as Error | null)?.message ?? t('admin.loadReportFailed')}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void salesQuery.refetch()}
              >
                {t('common.retry')}
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* 1. Revenue by day */}
            <ChartCard
              title={t('admin.revenueByDay')}
              description={t('admin.revenueByDayDesc')}
              empty={noSales}
              emptyLabel={t('admin.noSalesPeriod')}
            >
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={byDay} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={GRID_STROKE} />
                  <XAxis
                    dataKey="label"
                    tick={TICK_STYLE}
                    tickLine={false}
                    axisLine={{ stroke: GRID_STROKE }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tickFormatter={axisEGP}
                    tick={TICK_STYLE}
                    tickLine={false}
                    axisLine={false}
                    width={72}
                  />
                  <Tooltip
                    content={
                      <ChartTooltip
                        detail={(e) =>
                          ` · ${t('admin.paidOrders', { count: e.payload?.orders ?? 0 })}`
                        }
                      />
                    }
                    cursor={{ fill: 'rgba(217, 119, 6, 0.08)' }}
                  />
                  <Bar
                    dataKey="revenue"
                    name={t('money.revenue')}
                    fill="#d97706"
                    radius={[6, 6, 0, 0]}
                    maxBarSize={36}
                  />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            {/* 2. Revenue by hour */}
            <ChartCard
              title={t('admin.revenueByHour')}
              description={t('admin.revenueByHourDesc')}
              empty={noSales}
              emptyLabel={t('admin.noSalesPeriod')}
            >
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={byHour} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={GRID_STROKE} />
                  <XAxis
                    dataKey="label"
                    tick={TICK_STYLE}
                    tickLine={false}
                    axisLine={{ stroke: GRID_STROKE }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tickFormatter={axisEGP}
                    tick={TICK_STYLE}
                    tickLine={false}
                    axisLine={false}
                    width={72}
                  />
                  <Tooltip
                    content={<ChartTooltip />}
                    cursor={{ fill: 'rgba(245, 158, 11, 0.08)' }}
                  />
                  <Bar
                    dataKey="revenue"
                    name={t('money.revenue')}
                    fill="#f59e0b"
                    radius={[6, 6, 0, 0]}
                    maxBarSize={20}
                  />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            {/* 3. Top products (horizontal) */}
            <ChartCard
              title={t('admin.topProductsPeriod')}
              description={t('admin.topProductsPeriodDesc')}
              empty={noSales || topProducts.length === 0}
              emptyLabel={t('admin.noSalesPeriod')}
            >
              <ResponsiveContainer width="100%" height={280}>
                <BarChart
                  data={topProducts}
                  layout="vertical"
                  margin={{ top: 8, right: 16, left: 0, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={GRID_STROKE} />
                  <XAxis
                    type="number"
                    tickFormatter={axisEGP}
                    tick={TICK_STYLE}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={130}
                    interval={0}
                    tickFormatter={(v: string) => (v.length > 16 ? `${v.slice(0, 15)}…` : v)}
                    tick={TICK_STYLE}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    content={
                      <ChartTooltip
                        detail={(e) => ` · ${t('admin.sold', { qty: String(e.payload?.quantity ?? 0) })}`}
                      />
                    }
                    cursor={{ fill: 'rgba(5, 150, 105, 0.08)' }}
                  />
                  <Bar
                    dataKey="revenue"
                    name={t('money.revenue')}
                    fill="#059669"
                    radius={[0, 6, 6, 0]}
                    maxBarSize={18}
                  />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            {/* 4. Revenue by category (donut) */}
            <ChartCard
              title={t('admin.revenueByCategory')}
              description={t('admin.revenueByCategoryDesc')}
              empty={noSales || byCategory.length === 0}
              emptyLabel={t('admin.noSalesPeriod')}
            >
              <ResponsiveContainer width="100%" height={280}>
                <PieChart margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
                  <Pie
                    data={byCategory}
                    dataKey="revenue"
                    nameKey="name"
                    innerRadius={55}
                    outerRadius={85}
                    paddingAngle={2}
                    stroke="none"
                  >
                    {byCategory.map((entry, i) => (
                      <Cell
                        key={entry.categoryId ?? entry.name}
                        fill={PIE_PALETTE[i % PIE_PALETTE.length]}
                      />
                    ))}
                  </Pie>
                  <Tooltip content={<ChartTooltip />} />
                  <Legend
                    iconType="circle"
                    iconSize={8}
                    wrapperStyle={{ fontSize: 12, color: '#78716c' }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </ChartCard>

            {/* 5. Payment methods */}
            <Card>
              <CardHeader>
                <CardTitle>{t('admin.paymentMethods')}</CardTitle>
                <CardDescription>{t('admin.paymentMethodsDesc')}</CardDescription>
              </CardHeader>
              <CardContent>
                {byMethod.length === 0 ? (
                  <div className="flex h-[240px] items-center justify-center">
                    <p className="text-sm text-muted-foreground">
                      {t('admin.noPaymentsPeriod')}
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {byMethod.map((m) => {
                      const share = methodTotal > 0 ? (m.amount / methodTotal) * 100 : 0
                      return (
                        <div key={m.method} className="space-y-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-sm font-medium">
                              {t(`status.payment.${m.method}`)}
                            </p>
                            <div className="flex items-baseline gap-2">
                              <span className="text-xs text-muted-foreground">
                                {t('admin.paymentsCount', { count: m.count })}
                              </span>
                              <span className="text-sm font-semibold">
                                {formatCurrency(m.amount)}
                              </span>
                              <span className="w-10 text-end text-xs text-muted-foreground">
                                {Math.round(share)}%
                              </span>
                            </div>
                          </div>
                          <Progress value={share} />
                        </div>
                      )
                    })}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* 6. Inventory snapshot */}
            <Card>
              <CardHeader>
                <CardTitle>{t('admin.inventorySnapshot')}</CardTitle>
                <CardDescription>{t('admin.inventorySnapshotDesc')}</CardDescription>
              </CardHeader>
              <CardContent>
                {inventoryValueQuery.isLoading ? (
                  <Skeleton className="h-16 w-full" />
                ) : inventoryValueQuery.isError ? (
                  <p className="text-sm text-rose-600">
                    {(inventoryValueQuery.error as Error | null)?.message ??
                      t('admin.loadInventoryValueFailed')}
                  </p>
                ) : (
                  <div className="space-y-3">
                    <div className="flex items-center gap-3">
                      <Boxes className="size-5 text-emerald-600" />
                      <p className="text-2xl font-bold">
                        {formatCurrency(inventoryValueQuery.data?.totalValue ?? 0)}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                      <span>
                        {t('admin.itemsTracked', {
                          count: inventoryValueQuery.data?.itemCount ?? 0,
                        })}
                      </span>
                      <span
                        className={
                          (inventoryValueQuery.data?.lowStockCount ?? 0) > 0
                            ? 'font-medium text-amber-600'
                            : ''
                        }
                      >
                        {t('admin.lowStockCount', {
                          count: inventoryValueQuery.data?.lowStockCount ?? 0,
                        })}
                      </span>
                    </div>
                    <p className="text-xs font-medium text-primary underline-offset-2 hover:underline">
                      {t('admin.seeInventory')}
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>

      {/* Z-Report — end-of-day cash reconciliation (manual date + print) */}
      <ZReportSection />

      {/* R17: Refunds — manager-approved refunds against paid checks */}
      <RefundSection />

      {/* Menu engineering — popularity vs. margin quadrants */}
      <MenuEngineeringSection />
    </div>
  )
}
