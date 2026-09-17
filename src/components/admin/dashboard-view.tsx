'use client'

import { useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertCircle,
  Banknote,
  BarChart3,
  Boxes,
  ChefHat,
  Receipt,
  TrendingUp,
  Users,
  Utensils,
  type LucideIcon,
} from 'lucide-react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { toast } from 'sonner'
import { Sparkles } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { fetcher } from '@/lib/api'
import { WEEKDAY_KEYS } from '@/lib/constants'
// R17 restore: R9's AI briefing + copilot were fully built but had lost
// their render wiring (orphaned through later rounds) — back on the dashboard.
import AiBriefingCard from '@/components/admin/ai-briefing-card'
import AiCopilotSheet from '@/components/admin/ai-copilot-sheet'
import { formatCurrency, formatDate, formatLocale, formatQty, toDateInputValue } from '@/lib/format'
import type { ForecastReport, InventoryItem, Order, SalesReport } from '@/lib/types'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'

const QUICK_ACTIONS: { view: string; labelKey: string; icon: LucideIcon }[] = [
  { view: 'pos', labelKey: 'nav.pos', icon: Utensils },
  { view: 'kitchen', labelKey: 'nav.kitchen', icon: ChefHat },
  { view: 'inventory', labelKey: 'nav.inventory', icon: Boxes },
  { view: 'reports', labelKey: 'nav.reports', icon: BarChart3 },
]

/** Locale-aware date formatters (Latin digits in Arabic, per format.ts). */
function dayLocale(): string {
  return formatLocale() === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB'
}

/** "05 Mar" */
function dayShort(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`)
  if (Number.isNaN(d.getTime())) return dateStr
  return d.toLocaleDateString(dayLocale(), { day: '2-digit', month: 'short' })
}

/** "Tue, 05 Mar" */
function dayLabel(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`)
  if (Number.isNaN(d.getTime())) return dateStr
  return d.toLocaleDateString(dayLocale(), { weekday: 'short', day: '2-digit', month: 'short' })
}

/** Compact axis money: "E£12k" / "12 ألف ج.م" style (Latin digits in Arabic). */
function yTick(value: number): string {
  const locale = dayLocale()
  const compact = new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value)
  return formatLocale() === 'ar' ? `${compact} ج.م` : `E£${compact}`
}

export default function DashboardView({ onNavigate }: { onNavigate?: (view: string) => void }) {
  const { t } = useI18n()
  // R17 restore: copilot trigger state (admin-only sheet; the API 403s
  // for anyone else and the sheet surfaces errors gracefully)
  const [copilotOpen, setCopilotOpen] = useState(false)
  const today = useMemo(() => toDateInputValue(new Date()), [])
  const weekStart = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() - 6)
    return toDateInputValue(d)
  }, [])

  const todaySales = useQuery({
    queryKey: ['reports', 'sales', today, today],
    queryFn: () => fetcher<SalesReport>(`/api/reports/sales?from=${today}&to=${today}`),
  })

  const weekSales = useQuery({
    queryKey: ['reports', 'sales', weekStart, today],
    queryFn: () => fetcher<SalesReport>(`/api/reports/sales?from=${weekStart}&to=${today}`),
  })

  const openOrders = useQuery({
    queryKey: ['orders', 'open'],
    queryFn: () => fetcher<{ orders: Order[] }>('/api/orders?status=open'),
    refetchInterval: 5000,
  })

  const lowStock = useQuery({
    queryKey: ['inventory', 'low-stock'],
    queryFn: () => fetcher<{ items: InventoryItem[] }>('/api/inventory/low-stock'),
  })

  // Surface the first error via toast (fires once per new error message)
  const errorMessage =
    [todaySales, weekSales, openOrders, lowStock]
      .map((q) => (q.isError && q.error ? q.error.message : null))
      .find(Boolean) ?? null

  useEffect(() => {
    if (errorMessage) toast.error(errorMessage)
  }, [errorMessage])

  // Fill the full 7-day window so quiet days render as zero bars
  const weekData = useMemo(() => {
    const raw = weekSales.data?.byDay ?? []
    const byDate = new Map(raw.map((d) => [d.date, d]))
    const out: { date: string; revenue: number; orders: number }[] = []
    let hits = 0
    for (let i = 6; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const key = toDateInputValue(d)
      const found = byDate.get(key)
      if (found) {
        hits += 1
        out.push({ date: key, revenue: Number(found.revenue), orders: Number(found.orders) })
      } else {
        out.push({ date: key, revenue: 0, orders: 0 })
      }
    }
    // Date formats didn't line up — fall back to server data as-is
    if (hits === 0 && raw.length > 0) {
      return raw.map((d) => ({ date: String(d.date), revenue: Number(d.revenue), orders: Number(d.orders) }))
    }
    return out
  }, [weekSales.data])

  const hasWeekSales = (weekSales.data?.byDay?.length ?? 0) > 0

  const topProducts = useMemo(() => (weekSales.data?.topProducts ?? []).slice(0, 5), [weekSales.data])
  const maxTopRevenue = useMemo(
    () => Math.max(...topProducts.map((p) => p.revenue), 1),
    [topProducts],
  )

  const salesLoading = todaySales.isLoading
  const salesError = todaySales.isError

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      {/* Header — Odoo control-panel style (breadcrumb + title + subtitle) */}
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="space-y-1">
          <nav aria-label="Breadcrumb" className="text-xs text-muted-foreground">
            <span>{t('nav.home')}</span>
            <span className="mx-1.5" aria-hidden>
              /
            </span>
            <span className="font-medium text-primary">{t('admin.dashboard')}</span>
          </nav>
          <h1 className="text-2xl font-bold tracking-tight">{t('admin.dashboard')}</h1>
          <p className="text-sm text-muted-foreground">{t('admin.todayAtGlance')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            aria-label={t('ai.copilotTitle')}
            onClick={() => setCopilotOpen(true)}
          >
            <Sparkles className="size-4 text-primary" aria-hidden />
            <span className="hidden sm:inline">{t('ai.copilotTitle')}</span>
          </Button>
          <p className="text-xs text-muted-foreground">{formatDate(new Date())}</p>
        </div>
      </div>

      {/* R17 restore: AI morning briefing (self-fetching, graceful on error) */}
      <AiBriefingCard />

      {errorMessage && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" aria-hidden />
          <AlertTitle>{t('admin.dashboardError')}</AlertTitle>
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}

      {/* KPI cards */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <KpiCard
          label={t('admin.revenueToday')}
          icon={Banknote}
          iconClass="bg-emerald-100 text-emerald-700"
          loading={salesLoading}
          value={salesError ? '—' : formatCurrency(todaySales.data?.totalRevenue ?? 0)}
          sub={
            salesError
              ? t('admin.failedToLoad')
              : todaySales.data
                ? t('admin.ordersToday', { count: todaySales.data.totalOrders })
                : undefined
          }
          subError={salesError}
        />
        <KpiCard
          label={t('admin.openOrders')}
          icon={Utensils}
          iconClass="bg-primary/10 text-primary"
          loading={openOrders.isLoading}
          value={openOrders.isError ? '—' : String(openOrders.data?.orders.length ?? 0)}
          sub={
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" aria-hidden />
              {t('admin.liveRefresh')}
            </span>
          }
          subError={openOrders.isError}
        />
        <KpiCard
          label={t('money.avgOrderValue')}
          icon={Receipt}
          iconClass="bg-stone-100 text-stone-700"
          loading={salesLoading}
          value={salesError ? '—' : formatCurrency(todaySales.data?.avgOrderValue ?? 0)}
          sub={salesError ? t('admin.failedToLoad') : t('admin.perPaidOrder')}
          subError={salesError}
        />
        <KpiCard
          label={t('money.avgCheckPerPerson')}
          icon={Users}
          iconClass="bg-primary/15 text-primary"
          loading={salesLoading}
          value={salesError ? '—' : formatCurrency(todaySales.data?.avgCheckPerPerson ?? 0)}
          sub={
            salesError
              ? t('admin.failedToLoad')
              : todaySales.data
                ? t('admin.perGuestToday', { count: todaySales.data.totalGuests })
                : undefined
          }
          subError={salesError}
        />
        <KpiCard
          label={t('admin.lowStock')}
          icon={AlertCircle}
          iconClass="bg-amber-100 text-amber-700"
          loading={lowStock.isLoading}
          value={lowStock.isError ? '—' : String(lowStock.data?.items.length ?? 0)}
          sub={lowStock.isError ? t('admin.failedToLoad') : t('admin.belowThreshold')}
          subError={lowStock.isError}
        />
      </div>

      {/* Charts row */}
      <div className="grid gap-4 lg:grid-cols-3">
        {/* Revenue — last 7 days */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t('admin.revenueLast7')}</CardTitle>
            <CardDescription>
              {weekSales.isLoading
                ? t('common.loading')
                : weekSales.data
                  ? t('admin.acrossOrders', {
                      revenue: formatCurrency(weekSales.data.totalRevenue),
                      count: weekSales.data.totalOrders,
                    })
                  : t('admin.paidOrdersOnly')}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {weekSales.isError ? (
              <ChartError
                title={t('admin.chartLoadFailed')}
                message={weekSales.error instanceof Error ? weekSales.error.message : t('error.generic')}
              />
            ) : weekSales.isLoading ? (
              <Skeleton className="h-72 w-full" />
            ) : !hasWeekSales ? (
              <div className="grid h-72 place-items-center text-sm text-muted-foreground">
                {t('admin.noSalesYet')}
              </div>
            ) : (
              <div className="h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={weekData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="28%">
                    <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickFormatter={dayShort}
                      tick={{ fontSize: 11, fill: '#6b6b6b' }}
                      axisLine={{ stroke: 'var(--border)' }}
                      tickLine={false}
                      tickMargin={8}
                    />
                    <YAxis
                      tickFormatter={yTick}
                      width={70}
                      tick={{ fontSize: 11, fill: '#6b6b6b' }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      cursor={{ fill: 'rgba(113, 75, 103, 0.06)' }}
                      contentStyle={{
                        backgroundColor: '#ffffff',
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        fontSize: 12,
                        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.08)',
                      }}
                      labelStyle={{ color: '#6b6b6b', fontWeight: 600 }}
                      itemStyle={{ color: '#37352f' }}
                      labelFormatter={(label) => dayLabel(String(label))}
                      formatter={(value) => [formatCurrency(Number(value)), t('admin.revenue')] as [string, string]}
                    />
                    <Bar dataKey="revenue" fill="var(--primary)" radius={[6, 6, 0, 0]} maxBarSize={44} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Top products */}
        <Card>
          <CardHeader>
            <CardTitle>{t('admin.topProducts')}</CardTitle>
            <CardDescription>{t('admin.topProductsDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            {weekSales.isError ? (
              <ChartError
                title={t('admin.chartLoadFailed')}
                message={weekSales.error instanceof Error ? weekSales.error.message : t('error.generic')}
              />
            ) : weekSales.isLoading ? (
              <div className="space-y-4">
                {Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} className="space-y-1.5">
                    <div className="flex items-center gap-2.5">
                      <Skeleton className="h-6 w-6 rounded-md" />
                      <Skeleton className="h-4 flex-1" />
                      <Skeleton className="h-4 w-16" />
                    </div>
                    <Skeleton className="h-1.5 w-full" />
                  </div>
                ))}
              </div>
            ) : topProducts.length === 0 ? (
              <div className="grid h-72 place-items-center text-sm text-muted-foreground">
                {t('admin.noSalesYet')}
              </div>
            ) : (
              <ol className="space-y-4">
                {topProducts.map((p, i) => (
                  <li key={p.productId} className="space-y-1.5">
                    <div className="flex items-center gap-2.5">
                      <span
                        className={cn(
                          'grid h-6 w-6 shrink-0 place-items-center rounded-md text-xs font-bold',
                          i === 0 ? 'bg-primary text-primary-foreground' : 'bg-primary/10 text-primary',
                        )}
                        aria-hidden
                      >
                        {i + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium" title={p.name}>
                        {p.name}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {t('admin.sold', { qty: formatQty(p.quantity) })}
                      </span>
                      <span className="shrink-0 text-sm font-semibold tabular-nums">
                        {formatCurrency(p.revenue)}
                      </span>
                    </div>
                    <Progress
                      value={Math.min(100, (p.revenue / maxTopRevenue) * 100)}
                      className="h-1.5"
                      aria-label={t('admin.shareOfTop', { name: p.name })}
                    />
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>

      {/* R17: sales forecast — avg daily + 7-day projection */}
      <ForecastCard />

      {/* Quick actions */}
      {onNavigate && (
        <Card className="gap-3 p-5">
          <p className="text-sm font-semibold">{t('admin.quickActions')}</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {QUICK_ACTIONS.map((action) => {
              const Icon = action.icon
              return (
                <Button
                  key={action.view}
                  variant="outline"
                  onClick={() => onNavigate(action.view)}
                  className="h-16 flex-col gap-1.5 rounded-xl hover:border-primary hover:bg-primary/5 hover:text-primary"
                >
                  <Icon className="h-5 w-5" aria-hidden />
                  <span className="text-xs font-medium">{t(action.labelKey)}</span>
                </Button>
              )
            })}
          </div>
        </Card>
      )}

      {/* R17 restore: copilot chat sheet (triggered from the header) */}
      <AiCopilotSheet open={copilotOpen} onOpenChange={setCopilotOpen} />
    </div>
  )
}

function KpiCard({
  label,
  value,
  sub,
  icon: Icon,
  iconClass,
  loading,
  subError,
}: {
  label: string
  value: string
  sub?: React.ReactNode
  icon: LucideIcon
  iconClass: string
  loading?: boolean
  subError?: boolean
}) {
  return (
    <Card className="gap-3 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-sm text-muted-foreground">{label}</p>
          {loading ? <Skeleton className="h-8 w-24" /> : <p className="text-2xl font-bold leading-none tabular-nums">{value}</p>}
          {loading ? (
            <Skeleton className="h-3.5 w-20" />
          ) : (
            sub != null && (
              <p className={cn('flex min-h-[16px] items-center gap-1.5 text-xs', subError ? 'text-destructive' : 'text-muted-foreground')}>
                {sub}
              </p>
            )
          )}
        </div>
        <div className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-lg', iconClass)}>
          <Icon className="h-5 w-5" aria-hidden />
        </div>
      </div>
    </Card>
  )
}

function ChartError({ title, message }: { title: string; message: string }) {
  return (
    <div className="grid h-72 place-items-center px-4">
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" aria-hidden />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>{message}</AlertDescription>
      </Alert>
    </div>
  )
}

// ─── R17: sales forecast card (28-day history → 7-day projection) ────
// Component-local literals (the i18n dict files are owned elsewhere).

function ForecastCard() {
  const { t, lang } = useI18n()

  const forecast = useQuery({
    queryKey: ['forecast'],
    queryFn: () => fetcher<ForecastReport>('/api/reports/forecast'),
  })

  const title = lang === 'ar' ? 'توقعات المبيعات' : 'Sales Forecast'
  const avgDailyLabel = lang === 'ar' ? 'متوسط يومي (٢٨ يومًا)' : 'Avg / day (28d)'
  const weekLabel = lang === 'ar' ? 'الأيام السبعة القادمة' : 'Next 7 days'
  const noDataLabel = lang === 'ar' ? 'لا مبيعات بعد للتنبؤ' : 'No sales history to forecast yet'

  const projection = forecast.data?.projection ?? []
  const maxProjected = useMemo(
    () => Math.max(...projection.map((d) => d.projected ?? 0), 1),
    [projection],
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TrendingUp className="h-5 w-5 text-primary" aria-hidden />
          {title}
        </CardTitle>
        <CardDescription>
          {forecast.data ? `${forecast.data.from} → ${forecast.data.to}` : t('common.loading')}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {forecast.isError ? (
          <div className="grid h-28 place-items-center text-sm text-muted-foreground">
            {t('admin.failedToLoad')}
          </div>
        ) : forecast.isLoading ? (
          <div className="space-y-4">
            <div className="flex gap-8">
              <Skeleton className="h-12 w-28" />
              <Skeleton className="h-12 w-28" />
            </div>
            <Skeleton className="h-24 w-full" />
          </div>
        ) : projection.length === 0 || (forecast.data?.avgDaily ?? 0) === 0 ? (
          <div className="grid h-28 place-items-center text-sm text-muted-foreground">
            {noDataLabel}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-x-10 gap-y-3">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">{avgDailyLabel}</p>
                <p className="text-xl font-bold tabular-nums">
                  {formatCurrency(forecast.data?.avgDaily ?? 0)}
                </p>
              </div>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">{weekLabel}</p>
                <p className="text-xl font-bold tabular-nums">
                  {formatCurrency(forecast.data?.projectedWeekTotal ?? 0)}
                </p>
              </div>
            </div>
            {/* mini 7-day bar chart — pure divs on a fixed 64px track (h-16)
                so the tallest bar can never overflow into the value labels */}
            <div
              className="flex items-end gap-2 sm:gap-3"
              role="img"
              aria-label={`${title} — ${weekLabel}: ${formatCurrency(
                forecast.data?.projectedWeekTotal ?? 0,
              )}`}
            >
              {projection.map((day) => {
                const value = day.projected ?? 0
                const px = Math.max(4, Math.round((value / maxProjected) * 64))
                const weekday = new Date(`${day.date}T00:00:00`).getDay()
                return (
                  <div key={day.date} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                    <span className="text-[10px] tabular-nums text-muted-foreground">
                      {formatQty(value)}
                    </span>
                    <div className="flex h-16 w-full items-end">
                      <div
                        className="w-full rounded-t bg-primary/80"
                        style={{ height: px }}
                        title={`${day.date}: ${formatCurrency(value)}`}
                      />
                    </div>
                    <span className="truncate text-[10px] text-muted-foreground">
                      {t(`r17.day.${WEEKDAY_KEYS[weekday]}`)}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
