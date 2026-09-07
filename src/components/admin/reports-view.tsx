'use client'

import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  BarChart3,
  Boxes,
  CalendarRange,
  Receipt,
  TrendingUp,
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
import { fetcher } from '@/lib/api'
import type { InventoryValueReport, SalesReport } from '@/lib/types'
import { PAYMENT_METHOD_LABELS } from '@/lib/constants'
import { formatCurrency, formatDate, toDateInputValue } from '@/lib/format'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Skeleton } from '@/components/ui/skeleton'

function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return toDateInputValue(d)
}

function parseDay(value: string): Date {
  // 'YYYY-MM-DD' parsed as local midnight (avoids UTC off-by-one)
  return new Date(`${value}T00:00:00`)
}

function shortDay(dateStr: string): string {
  return parseDay(dateStr).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
  })
}

const COMPACT = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 1,
})

function axisEGP(value: number): string {
  return `E£${COMPACT.format(value)}`
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
  children,
}: {
  title: string
  description?: string
  empty?: boolean
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
            <p className="text-sm text-muted-foreground">No sales in this period</p>
          </div>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  )
}

// ─── Reports view ──────────────────────────────────────────────────

export default function ReportsView() {
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
    () => (report?.byHour ?? []).map((h) => ({ ...h, label: `${h.hour}h` })),
    [report],
  )
  const topProducts = report?.topProducts ?? []
  const byCategory = report?.byCategory ?? []
  const byMethod = report?.byMethod ?? []
  const methodTotal = byMethod.reduce((sum, m) => sum + m.amount, 0)

  function applyRange() {
    if (draftFrom > draftTo) {
      toast.error('“From” date must be on or before “To” date')
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
        <h1 className="text-2xl font-bold">Reports</h1>
        <p className="text-sm text-muted-foreground">
          Sales performance and inventory insights
        </p>
      </div>

      {/* Date range */}
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="report-from" className="text-xs text-muted-foreground">
              From
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
              To
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
            Apply
          </Button>
          <div className="ml-auto flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => applyQuickRange(1)}>
              Today
            </Button>
            <Button variant="outline" size="sm" onClick={() => applyQuickRange(7)}>
              7 days
            </Button>
            <Button variant="outline" size="sm" onClick={() => applyQuickRange(30)}>
              30 days
            </Button>
          </div>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Showing {formatDate(parseDay(range.from))} → {formatDate(parseDay(range.to))}
          {report ? ` · ${report.totalOrders} paid order${report.totalOrders === 1 ? '' : 's'}` : ''}
        </p>
      </Card>

      {/* KPI row */}
      <div className="grid gap-4 sm:grid-cols-3">
        {salesQuery.isLoading ? (
          <>
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-24 rounded-xl" />
          </>
        ) : (
          <>
            <Card className="gap-2 p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">Total revenue</p>
                <TrendingUp className="size-5 text-emerald-600" />
              </div>
              <p className="text-2xl font-bold">
                {formatCurrency(report?.totalRevenue ?? 0)}
              </p>
            </Card>
            <Card className="gap-2 p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">Orders</p>
                <Receipt className="size-5 text-muted-foreground" />
              </div>
              <p className="text-2xl font-bold">{report?.totalOrders ?? 0}</p>
            </Card>
            <Card className="gap-2 p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">Avg order value</p>
                <Wallet className="size-5 text-amber-600" />
              </div>
              <p className="text-2xl font-bold">
                {formatCurrency(report?.avgOrderValue ?? 0)}
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
                {(salesQuery.error as Error | null)?.message ?? 'Failed to load report'}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void salesQuery.refetch()}
              >
                Retry
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* 1. Revenue by day */}
            <ChartCard
              title="Revenue by day"
              description="Paid revenue per day (zero-filled, continuous)"
              empty={noSales}
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
                        detail={(e) => ` · ${e.payload?.orders ?? 0} order${(e.payload?.orders ?? 0) === 1 ? '' : 's'}`}
                      />
                    }
                    cursor={{ fill: 'rgba(217, 119, 6, 0.08)' }}
                  />
                  <Bar
                    dataKey="revenue"
                    name="Revenue"
                    fill="#d97706"
                    radius={[6, 6, 0, 0]}
                    maxBarSize={36}
                  />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            {/* 2. Revenue by hour */}
            <ChartCard
              title="Revenue by hour"
              description="Paid revenue split by hour of day (0–23)"
              empty={noSales}
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
                    name="Revenue"
                    fill="#f59e0b"
                    radius={[6, 6, 0, 0]}
                    maxBarSize={20}
                  />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            {/* 3. Top products (horizontal) */}
            <ChartCard
              title="Top products"
              description="Best sellers by revenue in the period"
              empty={noSales || topProducts.length === 0}
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
                      <ChartTooltip detail={(e) => ` · sold ${e.payload?.quantity ?? 0}`} />
                    }
                    cursor={{ fill: 'rgba(5, 150, 105, 0.08)' }}
                  />
                  <Bar
                    dataKey="revenue"
                    name="Revenue"
                    fill="#059669"
                    radius={[0, 6, 6, 0]}
                    maxBarSize={18}
                  />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            {/* 4. Revenue by category (donut) */}
            <ChartCard
              title="Revenue by category"
              description="Share of revenue across the menu"
              empty={noSales || byCategory.length === 0}
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
                <CardTitle>Payment methods</CardTitle>
                <CardDescription>How guests paid in the period</CardDescription>
              </CardHeader>
              <CardContent>
                {byMethod.length === 0 ? (
                  <div className="flex h-[240px] items-center justify-center">
                    <p className="text-sm text-muted-foreground">
                      No payments recorded in this period
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
                              {PAYMENT_METHOD_LABELS[m.method] ?? m.method}
                            </p>
                            <div className="flex items-baseline gap-2">
                              <span className="text-xs text-muted-foreground">
                                {m.count} payment{m.count === 1 ? '' : 's'}
                              </span>
                              <span className="text-sm font-semibold">
                                {formatCurrency(m.amount)}
                              </span>
                              <span className="w-10 text-right text-xs text-muted-foreground">
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
                <CardTitle>Inventory snapshot</CardTitle>
                <CardDescription>Current stock valuation</CardDescription>
              </CardHeader>
              <CardContent>
                {inventoryValueQuery.isLoading ? (
                  <Skeleton className="h-16 w-full" />
                ) : inventoryValueQuery.isError ? (
                  <p className="text-sm text-rose-600">
                    {(inventoryValueQuery.error as Error | null)?.message ??
                      'Failed to load inventory value'}
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
                        {inventoryValueQuery.data?.itemCount ?? 0} items tracked
                      </span>
                      <span
                        className={
                          (inventoryValueQuery.data?.lowStockCount ?? 0) > 0
                            ? 'font-medium text-amber-600'
                            : ''
                        }
                      >
                        {inventoryValueQuery.data?.lowStockCount ?? 0} low stock
                      </span>
                    </div>
                    <p className="text-xs font-medium text-primary underline-offset-2 hover:underline">
                      See Inventory tab
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </div>
  )
}
