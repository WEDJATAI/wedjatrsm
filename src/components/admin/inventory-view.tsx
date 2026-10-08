'use client'

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle,
  Boxes,
  Package,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { fetcher } from '@/lib/api'
import { useI18n } from '@/lib/i18n'
import type {
  InventoryItem,
  InventoryTransaction,
  InventoryValueReport,
} from '@/lib/types'
import { formatCurrency, formatDateTime, formatQty } from '@/lib/format'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
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
import {
  InventoryAdjustDialog,
  type InventoryAdjustTarget,
} from './inventory-adjust-dialog'

export default function InventoryView() {
  const { t } = useI18n()
  const [search, setSearch] = useState('')
  const [adjustTarget, setAdjustTarget] = useState<InventoryAdjustTarget | null>(null)

  const inventoryQuery = useQuery({
    queryKey: ['inventory'],
    queryFn: () => fetcher<{ items: InventoryItem[] }>('/api/inventory'),
  })
  const valueQuery = useQuery({
    queryKey: ['inventory-value'],
    queryFn: () => fetcher<InventoryValueReport>('/api/reports/inventory-value'),
  })
  const transactionsQuery = useQuery({
    queryKey: ['inventory-transactions'],
    queryFn: () =>
      fetcher<{ transactions: InventoryTransaction[] }>(
        '/api/inventory/transactions?limit=100',
      ),
  })

  const items = inventoryQuery.data?.items ?? []
  const lowItems = useMemo(() => items.filter((i) => i.isLow), [items])

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return items
    return items.filter(
      (i) =>
        i.name.toLowerCase().includes(q) ||
        (i.sku ?? '').toLowerCase().includes(q),
    )
  }, [items, search])

  const transactions = transactionsQuery.data?.transactions ?? []
  const refreshing =
    inventoryQuery.isFetching || valueQuery.isFetching || transactionsQuery.isFetching

  function refreshAll() {
    void inventoryQuery.refetch()
    void valueQuery.refetch()
    void transactionsQuery.refetch()
  }

  const lowStockCount = valueQuery.data?.lowStockCount ?? lowItems.length

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('nav.inventory')}</h1>
          <p className="text-sm text-muted-foreground">{t('admin.inventorySubtitle')}</p>
        </div>
        <Button variant="outline" onClick={refreshAll} disabled={refreshing}>
          <RefreshCw className={cn(refreshing && 'animate-spin')} />
          {t('common.refresh')}
        </Button>
      </div>

      {/* KPI row */}
      <div className="grid gap-4 sm:grid-cols-3">
        {valueQuery.isLoading ? (
          <>
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-24 rounded-xl" />
          </>
        ) : valueQuery.isError ? (
          <div className="sm:col-span-3 rounded-xl border border-rose-200 bg-rose-50/60 p-4 text-sm text-rose-700">
            {(valueQuery.error as Error | null)?.message ?? t('admin.loadInventoryValueFailed')}
          </div>
        ) : (
          <>
            <Card className="gap-2 p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">{t('admin.totalInventoryValue')}</p>
                <Boxes className="size-5 text-emerald-600" />
              </div>
              <p className="text-2xl font-bold">
                {formatCurrency(valueQuery.data?.totalValue ?? 0)}
              </p>
            </Card>
            <Card className="gap-2 p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">{t('admin.trackedItems')}</p>
                <Package className="size-5 text-muted-foreground" />
              </div>
              <p className="text-2xl font-bold">
                {valueQuery.data?.itemCount ?? items.length}
              </p>
            </Card>
            <Card className="gap-2 p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">{t('admin.lowStockAlerts')}</p>
                <AlertTriangle
                  className={cn(
                    'size-5',
                    lowStockCount > 0 ? 'text-rose-500' : 'text-amber-500',
                  )}
                />
              </div>
              <p
                className={cn(
                  'text-2xl font-bold',
                  lowStockCount > 0 && 'text-rose-600',
                )}
              >
                {lowStockCount}
              </p>
            </Card>
          </>
        )}
      </div>

      {/* Low stock alerts */}
      {!inventoryQuery.isLoading && !inventoryQuery.isError && lowItems.length > 0 && (
        <Card className="border-amber-300 bg-amber-50/50">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-amber-600" />
              {t('admin.lowStockBanner', { count: lowItems.length })}
            </CardTitle>
            <CardDescription>{t('admin.lowStockDesc')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {lowItems.map((item) => (
              <div
                key={item.productId}
                className="flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-background/70 px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{item.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {t('admin.stockThreshold', {
                      stock: formatQty(item.stock),
                      threshold: formatQty(item.lowStockThreshold),
                    })}
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={() => setAdjustTarget({ item, preset: 10 })}
                >
                  <Plus />
                  {t('admin.restock')}
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Stock table */}
      <Card>
        <CardHeader>
          <CardTitle>{t('admin.colStock')}</CardTitle>
          <CardDescription>
            {t('admin.itemCount', { count: filteredItems.length })}
            {search.trim() ? ` ${t('admin.matching', { q: search.trim() })}` : ''}
          </CardDescription>
          <CardAction>
            <div className="relative w-44 sm:w-64">
              <Search className="absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('admin.searchProduct')}
                className="ps-8"
              />
            </div>
          </CardAction>
        </CardHeader>
        <CardContent>
          {inventoryQuery.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : inventoryQuery.isError ? (
            <EmptyState
              icon={AlertTriangle}
              message={
                (inventoryQuery.error as Error | null)?.message ?? t('admin.loadInventoryFailed')
              }
            />
          ) : items.length === 0 ? (
            <EmptyState icon={Package} message={t('admin.noStockItems')} />
          ) : filteredItems.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t('admin.noItemsMatch', { q: search.trim() })}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('admin.product')}</TableHead>
                  <TableHead className="text-end">{t('admin.colStock')}</TableHead>
                  <TableHead className="text-end">{t('admin.unitCost')}</TableHead>
                  <TableHead className="text-end">{t('admin.value')}</TableHead>
                  <TableHead className="text-end">{t('admin.threshold')}</TableHead>
                  <TableHead>{t('common.status')}</TableHead>
                  <TableHead className="text-end">{t('common.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredItems.map((item) => (
                  <TableRow key={item.productId}>
                    <TableCell>
                      <p className="font-medium">{item.name}</p>
                      {item.sku ? (
                        <p className="text-xs text-muted-foreground">{item.sku}</p>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-end">
                      <span
                        className={cn(
                          'font-mono',
                          item.isLow
                            ? 'font-bold text-rose-600'
                            : item.stock <= item.lowStockThreshold * 2
                              ? 'text-amber-600'
                              : '',
                        )}
                      >
                        {formatQty(item.stock)}
                      </span>
                    </TableCell>
                    <TableCell className="text-end text-muted-foreground">
                      {formatCurrency(item.cost)}
                    </TableCell>
                    <TableCell className="text-end font-medium">
                      {formatCurrency(item.value)}
                    </TableCell>
                    <TableCell className="text-end text-muted-foreground">
                      {formatQty(item.lowStockThreshold)}
                    </TableCell>
                    <TableCell>
                      {item.isLow ? (
                        <Badge className="border-transparent bg-rose-100 text-rose-700">
                          {t('admin.low')}
                        </Badge>
                      ) : (
                        <Badge className="border-transparent bg-emerald-100 text-emerald-700">
                          {t('admin.ok')}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-end">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setAdjustTarget({ item })}
                      >
                        <SlidersHorizontal />
                        {t('admin.adjust')}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Recent movements */}
      <Card>
        <CardHeader>
          <CardTitle>{t('admin.recentMovements')}</CardTitle>
          <CardDescription>{t('admin.last100')}</CardDescription>
        </CardHeader>
        <CardContent>
          {transactionsQuery.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-12" />
              ))}
            </div>
          ) : transactionsQuery.isError ? (
            <EmptyState
              icon={AlertTriangle}
              message={
                (transactionsQuery.error as Error | null)?.message ?? t('admin.loadMovementsFailed')
              }
            />
          ) : transactions.length === 0 ? (
            <EmptyState icon={Package} message={t('admin.noMovements')} />
          ) : (
            <div className="max-h-96 divide-y overflow-y-auto rms-scroll">
              {transactions.map((tx) => {
                const change = tx.quantityChange
                return (
                  <div
                    key={tx.id}
                    className="flex items-center justify-between gap-3 py-2.5"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {tx.product?.name ?? t('admin.productN', { id: tx.productId })}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatDateTime(tx.createdAt)}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                      <ReasonBadge reason={tx.reason} />
                      {tx.orderId != null ? (
                        <Badge
                          variant="outline"
                          className="font-mono"
                          title={t('admin.deductedFromOrder')}
                        >
                          {t('admin.orderBadge', { id: tx.orderId })}
                        </Badge>
                      ) : null}
                      <span
                        className={cn(
                          'font-mono text-sm font-medium',
                          change >= 0 ? 'text-emerald-600' : 'text-rose-600',
                        )}
                      >
                        {change > 0 ? '+' : ''}
                        {formatQty(change)}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <InventoryAdjustDialog
        target={adjustTarget}
        onClose={() => setAdjustTarget(null)}
      />
    </div>
  )
}

function ReasonBadge({ reason }: { reason: string | null }) {
  const { t } = useI18n()
  // server stores notes inline, e.g. "purchase (supplier invoice #4)"
  const base = reason?.split(' (')[0] ?? ''
  const noteMatch = reason?.match(/\((.+)\)$/)
  const label = base
    ? `${t(`reason.${base}`)}${noteMatch ? ` (${noteMatch[1]})` : ''}`
    : t('admin.reasonUnknown')
  const className =
    reason === 'purchase'
      ? 'border-transparent bg-emerald-100 text-emerald-800'
      : reason === 'waste'
        ? 'border-transparent bg-rose-100 text-rose-700'
        : reason === 'adjustment'
          ? 'border-transparent bg-amber-100 text-amber-800'
          : 'border-transparent bg-zinc-100 text-zinc-700'
  return <Badge className={className}>{label}</Badge>
}

function EmptyState({ icon: Icon, message }: { icon: LucideIcon; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
      <Icon className="size-8 text-muted-foreground/50" />
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  )
}
