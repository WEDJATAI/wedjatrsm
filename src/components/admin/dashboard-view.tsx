'use client'

import { useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertCircle,
  Banknote,
  BarChart3,
  Boxes,
  ChefHat,
  Receipt,
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

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'
import { fetcher } from '@/lib/api'
import { formatCurrency, formatDate, formatQty, toDateInputValue } from '@/lib/format'
import type { InventoryItem, Order, SalesReport } from '@/lib/types'
import { cn } from '@/lib/utils'

const QUICK_ACTIONS: { view: string; label: string; icon: LucideIcon }[] = [
  { view: 'pos', label: 'POS', icon: Utensils },
  { view: 'kitchen', label: 'Kitchen', icon: ChefHat },
  { view: 'inventory', label: 'Inventory', icon: Boxes },
  { view: 'reports', label: 'Reports', icon: BarChart3 },
]

/** "05 Mar" */
function dayShort(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`)
  if (Number.isNaN(d.getTime())) return dateStr
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}

/** "Tue, 05 Mar" */
function dayLabel(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`)
  if (Number.isNaN(d.getTime())) return dateStr
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' })
}

function yTick(value: number): string {
  return `EGP ${Math.round(value)}`
}

export default function DashboardView({ onNavigate }: { onNavigate?: (view: string) => void }) {
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
            <span>Home</span>
            <span className="mx-1.5" aria-hidden>
              /
            </span>
            <span className="font-medium text-primary">Dashboard</span>
          </nav>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Today at a glance</p>
        </div>
        <p className="text-xs text-muted-foreground">{formatDate(new Date())}</p>
      </div>

      {errorMessage && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" aria-hidden />
          <AlertTitle>Some dashboard data failed to load</AlertTitle>
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}

      {/* KPI cards */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Revenue today"
          icon={Banknote}
          iconClass="bg-emerald-100 text-emerald-700"
          loading={salesLoading}
          value={salesError ? '—' : formatCurrency(todaySales.data?.totalRevenue ?? 0)}
          sub={
            salesError ? 'failed to load' : todaySales.data ? `${todaySales.data.totalOrders} orders today` : undefined
          }
          subError={salesError}
        />
        <KpiCard
          label="Open orders"
          icon={Utensils}
          iconClass="bg-primary/10 text-primary"
          loading={openOrders.isLoading}
          value={openOrders.isError ? '—' : String(openOrders.data?.orders.length ?? 0)}
          sub={
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" aria-hidden />
              live · refreshes 5s
            </span>
          }
          subError={openOrders.isError}
        />
        <KpiCard
          label="Avg order value"
          icon={Receipt}
          iconClass="bg-stone-100 text-stone-700"
          loading={salesLoading}
          value={salesError ? '—' : formatCurrency(todaySales.data?.avgOrderValue ?? 0)}
          sub={salesError ? 'failed to load' : 'per paid order today'}
          subError={salesError}
        />
        <KpiCard
          label="Low stock items"
          icon={AlertCircle}
          iconClass="bg-amber-100 text-amber-700"
          loading={lowStock.isLoading}
          value={lowStock.isError ? '—' : String(lowStock.data?.items.length ?? 0)}
          sub={lowStock.isError ? 'failed to load' : 'below reorder threshold'}
          subError={lowStock.isError}
        />
      </div>

      {/* Charts row */}
      <div className="grid gap-4 lg:grid-cols-3">
        {/* Revenue — last 7 days */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Revenue — last 7 days</CardTitle>
            <CardDescription>
              {weekSales.isLoading
                ? 'Loading…'
                : weekSales.data
                  ? `${formatCurrency(weekSales.data.totalRevenue)} across ${weekSales.data.totalOrders} paid orders`
                  : 'Paid orders only'}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {weekSales.isError ? (
              <ChartError message={weekSales.error instanceof Error ? weekSales.error.message : 'Request failed'} />
            ) : weekSales.isLoading ? (
              <Skeleton className="h-72 w-full" />
            ) : !hasWeekSales ? (
              <div className="grid h-72 place-items-center text-sm text-muted-foreground">No sales yet</div>
            ) : (
              <div className="h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={weekData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="28%">
                    <CartesianGrid stroke="#e2e2e0" strokeDasharray="3 3" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickFormatter={dayShort}
                      tick={{ fontSize: 11, fill: '#6b6b6b' }}
                      axisLine={{ stroke: '#e2e2e0' }}
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
                        border: '1px solid #e2e2e0',
                        borderRadius: 8,
                        fontSize: 12,
                        boxShadow: '0 4px 12px rgba(0, 0, 0, 0.08)',
                      }}
                      labelStyle={{ color: '#6b6b6b', fontWeight: 600 }}
                      itemStyle={{ color: '#37352f' }}
                      labelFormatter={(label) => dayLabel(String(label))}
                      formatter={(value) => [formatCurrency(Number(value)), 'Revenue'] as [string, string]}
                    />
                    <Bar dataKey="revenue" fill="#714B67" radius={[6, 6, 0, 0]} maxBarSize={44} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Top products */}
        <Card>
          <CardHeader>
            <CardTitle>Top products</CardTitle>
            <CardDescription>Best sellers · last 7 days</CardDescription>
          </CardHeader>
          <CardContent>
            {weekSales.isError ? (
              <ChartError message={weekSales.error instanceof Error ? weekSales.error.message : 'Request failed'} />
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
              <div className="grid h-72 place-items-center text-sm text-muted-foreground">No sales yet</div>
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
                      <span className="shrink-0 text-xs text-muted-foreground">{formatQty(p.quantity)} sold</span>
                      <span className="shrink-0 text-sm font-semibold tabular-nums">
                        {formatCurrency(p.revenue)}
                      </span>
                    </div>
                    <Progress
                      value={Math.min(100, (p.revenue / maxTopRevenue) * 100)}
                      className="h-1.5"
                      aria-label={`${p.name} share of top revenue`}
                    />
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Quick actions */}
      {onNavigate && (
        <Card className="gap-3 p-5">
          <p className="text-sm font-semibold">Quick actions</p>
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
                  <span className="text-xs font-medium">{action.label}</span>
                </Button>
              )
            })}
          </div>
        </Card>
      )}
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

function ChartError({ message }: { message: string }) {
  return (
    <div className="grid h-72 place-items-center px-4">
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" aria-hidden />
        <AlertTitle>Failed to load chart</AlertTitle>
        <AlertDescription>{message}</AlertDescription>
      </Alert>
    </div>
  )
}
