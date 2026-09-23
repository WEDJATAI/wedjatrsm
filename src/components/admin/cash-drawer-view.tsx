'use client'

// ─── Cash drawer session management view (R8) ────────────────────────
// Consumes GET /api/cash-drawer (status + live expected math, 15s polling
// while a session is open) and the POST endpoints (open / paid in / paid
// out / close). NOT mounted here — the main app wires it into the admin
// shell (page.tsx owns view mounting).

import { useState } from 'react'
import type { ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Banknote,
  CircleDollarSign,
  Coins,
  History,
  Info,
  Lock,
  Timer,
  TriangleAlert,
  Wallet,
} from 'lucide-react'

import { apiFetch, fetcher } from '@/lib/api'
import { formatCurrency, formatDateTime, formatTime } from '@/lib/format'
import type { CashDrawerSessionDTO, CashDrawerStatus } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useI18n } from '@/lib/i18n'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
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
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

const round2 = (n: number): number => Math.round(n * 100) / 100

/** Variance text tone: balanced (±0.02) emerald · small (≤50) amber · big rose. */
function varianceTone(v: number): string {
  const abs = Math.abs(v)
  if (abs <= 0.02) return 'text-emerald-600 dark:text-emerald-400'
  if (abs <= 50) return 'text-amber-600 dark:text-amber-400'
  return 'text-rose-600 dark:text-rose-400'
}

function varianceText(v: number): string {
  return `${v > 0 ? '+' : ''}${formatCurrency(v)}`
}

export default function CashDrawerView() {
  const { t, lang } = useI18n()
  const queryClient = useQueryClient()

  // form state
  const [openingFloat, setOpeningFloat] = useState('')
  const [entryDialog, setEntryDialog] = useState<'paid_in' | 'paid_out' | null>(null)
  const [entryAmount, setEntryAmount] = useState('')
  const [entryNote, setEntryNote] = useState('')
  const [closeOpen, setCloseOpen] = useState(false)
  const [countedCash, setCountedCash] = useState('')
  const [closeNote, setCloseNote] = useState('')

  const drawerQuery = useQuery({
    queryKey: ['cash-drawer'],
    queryFn: () => fetcher<{ status: CashDrawerStatus }>('/api/cash-drawer'),
    // live refresh only while a session is open
    refetchInterval: (query) => (query.state.data?.status.active ? 15_000 : false),
  })

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['cash-drawer'] })
  }

  const openMutation = useMutation({
    mutationFn: (float: number) =>
      apiFetch<{ session: CashDrawerSessionDTO }>('/api/cash-drawer', {
        body: { action: 'open', openingFloat: float },
      }),
    onSuccess: () => {
      toast.success(t('admin.drawerOpenedToast'))
      setOpeningFloat('')
    },
    onError: (err: Error) => toast.error(err.message),
    onSettled: invalidate,
  })

  const entryMutation = useMutation({
    mutationFn: (payload: { action: 'paid_in' | 'paid_out'; amount: number; note?: string }) =>
      apiFetch<{ entry: unknown }>('/api/cash-drawer', { body: payload }),
    onSuccess: () => {
      toast.success(t('admin.entryAddedToast'))
      setEntryDialog(null)
      setEntryAmount('')
      setEntryNote('')
    },
    onError: (err: Error) => toast.error(err.message),
    onSettled: invalidate,
  })

  const closeMutation = useMutation({
    mutationFn: (payload: { id: number; countedCash: number; note?: string }) =>
      apiFetch<{ session: CashDrawerSessionDTO }>(`/api/cash-drawer/${payload.id}`, {
        body: { action: 'close', countedCash: payload.countedCash, note: payload.note },
      }),
    onSuccess: (data) => {
      toast.success(
        t('admin.drawerClosedToast', { var: formatCurrency(data.session.variance ?? 0) }),
      )
      setCloseOpen(false)
      setCountedCash('')
      setCloseNote('')
    },
    onError: (err: Error) => toast.error(err.message),
    onSettled: invalidate,
  })

  const status = drawerQuery.data?.status
  const active = status?.active ?? null
  const expected = status?.expected ?? null
  const recentSessions = status?.recentSessions ?? []
  const entries = active?.entries ?? []
  const loading = drawerQuery.isLoading

  // local validation
  const floatValid =
    openingFloat.trim() !== '' &&
    Number.isFinite(Number(openingFloat)) &&
    Number(openingFloat) >= 0
  const entryValid =
    entryAmount.trim() !== '' &&
    Number.isFinite(Number(entryAmount)) &&
    Number(entryAmount) > 0
  const countedValid =
    countedCash.trim() !== '' &&
    Number.isFinite(Number(countedCash)) &&
    Number(countedCash) >= 0

  // live variance preview inside the close dialog
  const expectedTotal = expected?.total ?? 0
  const previewVariance =
    active && countedValid ? round2(Number(countedCash) - expectedTotal) : null

  function submitEntry() {
    if (entryDialog == null) return
    if (!entryValid) {
      toast.error(t('admin.amountRequired'))
      return
    }
    const note = entryNote.trim()
    entryMutation.mutate({
      action: entryDialog,
      amount: round2(Number(entryAmount)),
      note: note === '' ? undefined : note,
    })
  }

  function submitClose() {
    if (active == null) return
    if (!countedValid) {
      toast.error(t('admin.amountRequired'))
      return
    }
    const note = closeNote.trim()
    closeMutation.mutate({
      id: active.id,
      countedCash: round2(Number(countedCash)),
      note: note === '' ? undefined : note,
    })
  }

  const moneyLabel = (label: string, value: number, icon?: ReactNode) => (
    <Card className="gap-2 p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{label}</p>
        {icon}
      </div>
      <p className="text-xl font-bold tabular-nums">{formatCurrency(value)}</p>
    </Card>
  )

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="space-y-1">
          <nav aria-label="Breadcrumb" className="text-xs text-muted-foreground">
            <span>{t('nav.home')}</span>
            <span className="mx-1.5" aria-hidden>
              /
            </span>
            <span className="font-medium text-primary">{t('nav.cashdrawer')}</span>
          </nav>
          <h1 className="text-2xl font-bold tracking-tight">{t('admin.cashDrawerTitle')}</h1>
          <p className="text-sm text-muted-foreground">{t('admin.cashDrawerSubtitle')}</p>
        </div>
        {active && !drawerQuery.isError ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" aria-hidden />
            {t('common.live')}
          </span>
        ) : null}
      </div>

      {drawerQuery.isError ? (
        <Card className="p-4">
          <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
            <TriangleAlert className="size-10 text-destructive" aria-hidden />
            <p className="text-sm text-rose-600">
              {(drawerQuery.error as Error | null)?.message ?? t('common.error')}
            </p>
            <Button
              variant="outline"
              className="h-11"
              onClick={() => void drawerQuery.refetch()}
            >
              {t('common.retry')}
            </Button>
          </div>
        </Card>
      ) : loading ? (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-24 rounded-xl" />
            ))}
          </div>
          <Skeleton className="h-64 w-full rounded-xl" />
          <Skeleton className="h-48 w-full rounded-xl" />
        </div>
      ) : active ? (
        <div className="space-y-6">
          {/* Active session card */}
          <Card className="gap-4 p-4 sm:p-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge className="gap-1.5 border-emerald-600/40 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-400">
                    <span
                      className="h-2 w-2 animate-pulse rounded-full bg-emerald-500"
                      aria-hidden
                    />
                    {t('admin.drawerOpenSince', { time: formatTime(active.openedAt, lang) })}
                  </Badge>
                  <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <Banknote className="size-4" aria-hidden />
                    {t('admin.drawerBy', { name: active.user?.name ?? '—' })}
                  </span>
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Timer className="size-3.5" aria-hidden />
                    {formatDateTime(active.openedAt, lang)}
                  </span>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  className="h-11"
                  disabled={entryMutation.isPending}
                  onClick={() => {
                    setEntryAmount('')
                    setEntryNote('')
                    setEntryDialog('paid_in')
                  }}
                >
                  <ArrowDownToLine className="text-emerald-600" aria-hidden />
                  {t('admin.paidIn')}
                </Button>
                <Button
                  variant="outline"
                  className="h-11"
                  disabled={entryMutation.isPending}
                  onClick={() => {
                    setEntryAmount('')
                    setEntryNote('')
                    setEntryDialog('paid_out')
                  }}
                >
                  <ArrowUpFromLine className="text-rose-600" aria-hidden />
                  {t('admin.paidOut')}
                </Button>
                <Button
                  variant="outline"
                  className="h-11 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive dark:border-destructive/50"
                  disabled={closeMutation.isPending}
                  onClick={() => {
                    setCountedCash('')
                    setCloseNote('')
                    setCloseOpen(true)
                  }}
                >
                  <Lock aria-hidden />
                  {t('admin.closeDrawer')}
                </Button>
              </div>
            </div>

            {/* Expected cash stats */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Card className="gap-2 border-primary/30 bg-primary/5 p-4 sm:col-span-2 lg:col-span-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm text-muted-foreground">{t('admin.expectedCash')}</p>
                  <CircleDollarSign className="size-5 text-primary" aria-hidden />
                </div>
                <p className="text-3xl font-bold tabular-nums text-primary">
                  {formatCurrency(expectedTotal)}
                </p>
              </Card>
              {moneyLabel(
                t('admin.cashSales'),
                expected?.cashSales ?? 0,
                <Wallet className="size-5 text-muted-foreground" aria-hidden />,
              )}
              {moneyLabel(
                t('admin.cashTips'),
                expected?.cashTips ?? 0,
                <Coins className="size-5 text-amber-600" aria-hidden />,
              )}
              {moneyLabel(
                t('admin.paidIn'),
                expected?.paidIn ?? 0,
                <ArrowDownToLine className="size-5 text-emerald-600" aria-hidden />,
              )}
              {moneyLabel(
                t('admin.paidOut'),
                expected?.paidOut ?? 0,
                <ArrowUpFromLine className="size-5 text-rose-600" aria-hidden />,
              )}
            </div>

            {/* Expected breakdown */}
            <div className="rounded-xl border p-4">
              <p className="mb-2 text-sm font-semibold">{t('admin.expectedBreakdown')}</p>
              <div className="space-y-1.5 text-sm">
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">{t('admin.openingFloat')}</span>
                  <span className="tabular-nums">
                    {formatCurrency(expected?.openingFloat ?? 0)}
                  </span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">
                    {t('admin.cashSales')} + {t('admin.cashTips')}
                  </span>
                  <span className="tabular-nums">
                    {formatCurrency((expected?.cashSales ?? 0) + (expected?.cashTips ?? 0))}
                  </span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">{t('admin.drawerChangeGiven')}</span>
                  <span className="tabular-nums text-rose-600 dark:text-rose-400">
                    −{formatCurrency(expected?.changeGiven ?? 0)}
                  </span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">{t('admin.paidIn')}</span>
                  <span className="tabular-nums text-emerald-600 dark:text-emerald-400">
                    +{formatCurrency(expected?.paidIn ?? 0)}
                  </span>
                </div>
                <div className="flex justify-between gap-4">
                  <span className="text-muted-foreground">{t('admin.paidOut')}</span>
                  <span className="tabular-nums text-rose-600 dark:text-rose-400">
                    −{formatCurrency(expected?.paidOut ?? 0)}
                  </span>
                </div>
                <div className="flex justify-between gap-4 border-t pt-1.5 font-semibold">
                  <span>{t('admin.expectedCash')}</span>
                  <span className="tabular-nums">{formatCurrency(expectedTotal)}</span>
                </div>
              </div>
            </div>

            {/* Live entries of this session */}
            {entries.length > 0 ? (
              <div className="rounded-xl border">
                <div className="flex items-center gap-2 border-b px-4 py-2.5">
                  <History className="size-4 text-muted-foreground" aria-hidden />
                  <p className="text-sm font-semibold">
                    {t('admin.paidIn')} / {t('admin.paidOut')}
                  </p>
                  <Badge variant="outline" className="ms-auto tabular-nums">
                    {entries.length}
                  </Badge>
                </div>
                <div className="rms-scroll max-h-64 divide-y overflow-y-auto">
                  {entries.map((e) => (
                    <div key={e.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                      <span className="w-12 shrink-0 text-xs text-muted-foreground tabular-nums">
                        {formatTime(e.createdAt, lang)}
                      </span>
                      {e.type === 'paid_in' ? (
                        <ArrowDownToLine className="size-4 shrink-0 text-emerald-600" aria-hidden />
                      ) : (
                        <ArrowUpFromLine className="size-4 shrink-0 text-rose-600" aria-hidden />
                      )}
                      <span
                        className={cn(
                          'font-medium tabular-nums',
                          e.type === 'paid_in'
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-rose-600 dark:text-rose-400',
                        )}
                      >
                        {e.type === 'paid_in' ? '+' : '−'}
                        {formatCurrency(e.amount)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        {e.note ?? ''}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {e.user?.name ?? '—'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </Card>
        </div>
      ) : (
        <div className="space-y-6">
          {/* No open session — empty state + open form */}
          <Card className="p-4">
            <div className="flex flex-col items-center justify-center gap-2 py-6 text-center">
              <Banknote className="size-10 text-muted-foreground/40" aria-hidden />
              <p className="text-sm text-muted-foreground">{t('admin.noActiveDrawer')}</p>
            </div>
          </Card>

          <Card className="p-4 sm:p-6">
            <p className="mb-4 text-sm font-semibold">{t('admin.openDrawer')}</p>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="drawer-float" className="text-xs text-muted-foreground">
                  {t('admin.openingFloat')}
                </Label>
                <Input
                  id="drawer-float"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  value={openingFloat}
                  placeholder={t('admin.openingFloatPh')}
                  onChange={(e) => setOpeningFloat(e.target.value)}
                  className="h-11 w-44"
                />
              </div>
              <Button
                className="h-11"
                disabled={!floatValid || openMutation.isPending}
                onClick={() => openMutation.mutate(round2(Number(openingFloat)))}
              >
                <Banknote aria-hidden />
                {t('admin.openDrawer')}
              </Button>
            </div>
          </Card>
        </div>
      )}

      {/* Recent closed sessions */}
      <Card className="p-4">
        <div className="mb-3 flex items-center gap-2">
          <History className="size-4 text-muted-foreground" aria-hidden />
          <p className="text-sm font-semibold">{t('admin.drawerHistory')}</p>
        </div>
        {recentSessions.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {t('admin.noSessions')}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-xs">{t('common.date')}</TableHead>
                  <TableHead className="text-xs">{t('common.time')}</TableHead>
                  <TableHead className="text-end text-xs">{t('admin.openingFloat')}</TableHead>
                  <TableHead className="text-end text-xs">{t('admin.expectedCash')}</TableHead>
                  <TableHead className="text-end text-xs">{t('admin.countedCash')}</TableHead>
                  <TableHead className="text-end text-xs">{t('admin.variance')}</TableHead>
                  <TableHead className="text-xs">{t('common.name')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentSessions.map((s) => {
                  const variance = s.variance ?? 0
                  return (
                    <TableRow key={s.id}>
                      <TableCell className="whitespace-nowrap text-xs tabular-nums">
                        {formatDateTime(s.openedAt, lang)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs tabular-nums">
                        {s.closedAt
                          ? t('admin.drawerClosedAt', { time: formatTime(s.closedAt, lang) })
                          : '—'}
                      </TableCell>
                      <TableCell className="text-end text-xs tabular-nums">
                        {formatCurrency(s.openingFloat)}
                      </TableCell>
                      <TableCell className="text-end text-xs tabular-nums">
                        {s.expectedCash == null ? '—' : formatCurrency(s.expectedCash)}
                      </TableCell>
                      <TableCell className="text-end text-xs tabular-nums">
                        {s.countedCash == null ? '—' : formatCurrency(s.countedCash)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-end text-xs font-semibold tabular-nums',
                          varianceTone(variance),
                        )}
                      >
                        {varianceText(variance)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        {s.note ? (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className="inline-flex cursor-help items-center gap-1">
                                {s.user?.name ?? '—'}
                                <Info className="size-3.5 text-muted-foreground" aria-hidden />
                              </span>
                            </TooltipTrigger>
                            <TooltipContent side="top" className="max-w-56">
                              {s.note}
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <span>{s.user?.name ?? '—'}</span>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      {/* Paid in / Paid out dialog */}
      <Dialog
        open={entryDialog !== null}
        onOpenChange={(open) => {
          if (!open) setEntryDialog(null)
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {entryDialog === 'paid_in' ? t('admin.paidIn') : t('admin.paidOut')}
            </DialogTitle>
            <DialogDescription>{t('admin.cashDrawerSubtitle')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="entry-amount" className="text-xs text-muted-foreground">
                {t('pos.amountAria', {
                  label:
                    entryDialog === 'paid_in' ? t('admin.paidIn') : t('admin.paidOut'),
                })}
              </Label>
              <Input
                id="entry-amount"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={entryAmount}
                placeholder={t('admin.openingFloatPh')}
                onChange={(e) => setEntryAmount(e.target.value)}
                className="h-11"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="entry-note" className="text-xs text-muted-foreground">
                {t('admin.noteLabel')}
              </Label>
              <Input
                id="entry-note"
                value={entryNote}
                placeholder={t('admin.entryNotePh')}
                maxLength={200}
                onChange={(e) => setEntryNote(e.target.value)}
                className="h-11"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEntryDialog(null)}>
              {t('common.cancel')}
            </Button>
            <Button disabled={entryMutation.isPending} onClick={submitEntry}>
              {entryDialog === 'paid_in' ? (
                <ArrowDownToLine aria-hidden />
              ) : (
                <ArrowUpFromLine aria-hidden />
              )}
              {t('common.apply')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Close drawer dialog */}
      <AlertDialog open={closeOpen} onOpenChange={setCloseOpen}>
        <AlertDialogContent className="sm:max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin.closeDrawerTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('admin.varianceHint')}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="close-counted" className="text-xs text-muted-foreground">
                {t('admin.countedCash')}
              </Label>
              <Input
                id="close-counted"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={countedCash}
                placeholder={t('admin.openingFloatPh')}
                onChange={(e) => setCountedCash(e.target.value)}
                className="h-11"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="close-note" className="text-xs text-muted-foreground">
                {t('admin.noteLabel')}
              </Label>
              <Input
                id="close-note"
                value={closeNote}
                placeholder={t('admin.notePh')}
                maxLength={300}
                onChange={(e) => setCloseNote(e.target.value)}
                className="h-11"
              />
            </div>
            {/* Live variance preview */}
            <div className="flex items-center justify-between gap-4 rounded-xl border bg-muted/40 px-4 py-3">
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">{t('admin.expectedCash')}</p>
                <p className="text-sm font-semibold tabular-nums">
                  {formatCurrency(expectedTotal)}
                </p>
              </div>
              <div className="min-w-0 text-end">
                <p className="text-xs text-muted-foreground">{t('admin.variance')}</p>
                <p
                  className={cn(
                    'text-sm font-bold tabular-nums',
                    previewVariance == null
                      ? 'text-muted-foreground'
                      : varianceTone(previewVariance),
                  )}
                >
                  {previewVariance == null ? '—' : varianceText(previewVariance)}
                </p>
              </div>
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={closeMutation.isPending}>
              {t('common.cancel')}
            </AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={closeMutation.isPending || !countedValid}
              onClick={submitClose}
            >
              <Lock aria-hidden />
              {t('admin.closeDrawer')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
