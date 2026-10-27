'use client'

// ─── R17 Stock Counts + Waste module (Foodics Stock Count / Waste) ──
// Two tabs: Count Sheets | Waste. A count sheet snapshots every active
// stockable item, captures counted quantities, and posts variances to
// the inventory ledger as 'adjustment' transactions (server-side). The
// Waste tab logs losses valued at cost, with reason analytics and a
// top-items report. TanStack Query + sonner toasts throughout; strings
// come from the r17 dictionary with component-local EN/AR literals for
// the few missing keys.

import { useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Ban,
  Check,
  ChevronRight,
  ChevronsUpDown,
  ClipboardList,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { apiFetch, fetcher } from '@/lib/api'
import { localizedName, useI18n } from '@/lib/i18n'
import { WASTE_REASONS } from '@/lib/constants'
import type { Product, StockCountDTO, WasteLogDTO, WasteReport } from '@/lib/types'
import {
  formatCurrency,
  formatDateTime,
  formatQty,
  toDateInputValue,
} from '@/lib/format'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
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
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

// ── helpers ─────────────────────────────────────────────────────────

const round2 = (n: number): number => Math.round(n * 100) / 100

/** variances at or below this magnitude count as "no difference" (server mirror) */
const VARIANCE_EPSILON = 0.001

/** component-local bilingual literals (strings missing from the r17 dict) */
type LocStr = { en: string; ar: string }
function L(s: LocStr, lang: string): string {
  return lang === 'ar' ? s.ar : s.en
}

const LOC = {
  by: { en: 'By', ar: 'بواسطة' },
  inStock: { en: 'in stock', ar: 'في المخزون' },
  noProductsFound: { en: 'No items match your search', ar: 'لا توجد أصناف مطابقة للبحث' },
  openSheetAria: { en: 'Open count sheet', ar: 'فتح قائمة الجرد' },
  unsavedHint: {
    en: 'You have unsaved counts — save them before posting.',
    ar: 'لديك عدّ غير محفوظ — احفظه قبل الترحيل.',
  },
  invalidCounts: {
    en: 'Counted quantities must be numbers ≥ 0.',
    ar: 'يجب أن تكون الكميات المعدودة أرقامًا ≥ 0.',
  },
  loadFailed: { en: 'Failed to load data', ar: 'تعذر تحميل البيانات' },
} as const

const SC_STATUS_LABEL: Record<string, string> = {
  open: 'r17.count.statusOpen',
  posted: 'r17.count.statusPosted',
  cancelled: 'r17.count.statusCancelled',
}

const SC_STATUS_STYLE: Record<string, string> = {
  open: 'bg-amber-500/15 text-amber-600',
  posted: 'bg-emerald-500/15 text-emerald-600',
  cancelled: 'bg-muted text-muted-foreground',
}

const WASTE_REASON_LABEL: Record<string, string> = {
  spoilage: 'r17.waste.reason.spoilage',
  expired: 'r17.waste.reason.expired',
  breakage: 'r17.waste.reason.breakage',
  overproduction: 'r17.waste.reason.overproduction',
  complimentary: 'r17.waste.reason.complimentary',
  other: 'r17.waste.reason.other',
}

const WASTE_REASON_STYLE: Record<string, string> = {
  spoilage: 'bg-rose-500/15 text-rose-600',
  expired: 'bg-amber-500/15 text-amber-600',
  breakage: 'bg-zinc-500/15 text-zinc-600',
  overproduction: 'bg-teal-500/15 text-teal-600',
  complimentary: 'bg-emerald-500/15 text-emerald-600',
  other: 'bg-muted text-muted-foreground',
}

/** stock changed (count posting / waste) → refresh every inventory surface */
function useInvalidateStock() {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: ['products'] })
    void qc.invalidateQueries({ queryKey: ['inventory'] })
    void qc.invalidateQueries({ queryKey: ['inventory-value'] })
    void qc.invalidateQueries({ queryKey: ['inventory-transactions'] })
  }
}

// ── shared bits ─────────────────────────────────────────────────────

function ScStatusBadge({ status }: { status: string }) {
  const { t } = useI18n()
  return (
    <Badge
      className={cn(
        'border-transparent',
        SC_STATUS_STYLE[status] ?? 'bg-muted text-muted-foreground',
      )}
    >
      {SC_STATUS_LABEL[status] ? t(SC_STATUS_LABEL[status]) : status}
    </Badge>
  )
}

function WasteReasonBadge({ reason }: { reason: string }) {
  const { t } = useI18n()
  return (
    <Badge
      className={cn(
        'border-transparent',
        WASTE_REASON_STYLE[reason] ?? 'bg-muted text-muted-foreground',
      )}
    >
      {WASTE_REASON_LABEL[reason] ? t(WASTE_REASON_LABEL[reason]) : reason}
    </Badge>
  )
}

function QueryError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useI18n()
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-rose-200 bg-rose-50/60 p-6 text-center">
      <AlertTriangle className="size-8 text-rose-500" />
      <p className="text-sm text-rose-700">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw />
        {t('r17.common.retry')}
      </Button>
    </div>
  )
}

function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2 p-4">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-16" />
      ))}
    </div>
  )
}

function EmptyState({ icon: Icon, message }: { icon: LucideIcon; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
      <Icon className="size-8 text-muted-foreground/50" />
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  )
}

// ─── main view ──────────────────────────────────────────────────────

export default function StockcountsView() {
  const { t } = useI18n()
  const [tab, setTab] = useState<'counts' | 'waste'>('counts')
  const onWaste = tab === 'waste'

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-bold">
          {t(onWaste ? 'r17.waste.title' : 'r17.count.title')}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t(onWaste ? 'r17.waste.subtitle' : 'r17.count.subtitle')}
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as 'counts' | 'waste')} className="gap-4">
        <TabsList className="w-full sm:w-auto">
          <TabsTrigger value="counts">
            <ClipboardList />
            {t('r17.count.title')}
          </TabsTrigger>
          <TabsTrigger value="waste">
            <Trash2 />
            {t('r17.waste.title')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="counts">
          <CountSheetsTab />
        </TabsContent>
        <TabsContent value="waste">
          <WasteTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ─── count sheets tab ───────────────────────────────────────────────

function CountSheetsTab() {
  const { t } = useI18n()
  const [newOpen, setNewOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)

  const sheetsQuery = useQuery({
    queryKey: ['stock-counts'],
    queryFn: () => fetcher<{ stockCounts: StockCountDTO[] }>('/api/stock-counts'),
  })
  // API returns newest first — keep it stable for detail lookups
  const sheets = useMemo(
    () => [...(sheetsQuery.data?.stockCounts ?? [])].sort((a, b) => b.id - a.id),
    [sheetsQuery.data],
  )
  const selected = sheets.find((s) => s.id === selectedId) ?? null

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t('r17.count.subtitle')}</p>
        <Button size="sm" onClick={() => setNewOpen(true)}>
          <Plus />
          {t('r17.count.new')}
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('r17.count.number')}</CardTitle>
          <CardDescription>{t('r17.count.postDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {sheetsQuery.isLoading ? (
            <ListSkeleton rows={4} />
          ) : sheetsQuery.isError ? (
            <div className="p-4">
              <QueryError
                message={
                  (sheetsQuery.error as Error | null)?.message ?? L(LOC.loadFailed, 'en')
                }
                onRetry={() => void sheetsQuery.refetch()}
              />
            </div>
          ) : sheets.length === 0 ? (
            <EmptyState icon={ClipboardList} message={t('r17.count.empty')} />
          ) : (
            <div className="divide-y">
              {sheets.map((sheet) => (
                <SheetRow key={sheet.id} sheet={sheet} onOpen={() => setSelectedId(sheet.id)} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <NewSheetDialog open={newOpen} onClose={() => setNewOpen(false)} />
      {selected ? (
        <CountDetailDialog
          key={selected.id}
          sheet={selected}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
    </div>
  )
}

function SheetRow({ sheet, onOpen }: { sheet: StockCountDTO; onOpen: () => void }) {
  const { t } = useI18n()
  const counted = sheet.lines.filter((l) => l.countedQty !== null).length
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${L(LOC.openSheetAria, 'en')} ${sheet.number}`}
      className="flex w-full flex-wrap items-center gap-x-4 gap-y-1.5 px-4 py-3 text-start transition-colors hover:bg-muted/50 focus-visible:bg-muted/50"
    >
      <span className="font-mono text-sm font-semibold">{sheet.number}</span>
      <ScStatusBadge status={sheet.status} />
      <span className="text-xs text-muted-foreground">{formatDateTime(sheet.createdAt)}</span>
      <span className="ms-auto flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="text-xs text-muted-foreground">
          {t('r17.count.counted', { counted, total: sheet.lines.length })}
        </span>
        <span className="font-mono text-sm font-medium">
          {formatCurrency(sheet.totalValueImpact)}
        </span>
        <ChevronRight className="size-4 text-muted-foreground rtl:rotate-180" />
      </span>
    </button>
  )
}

// ── new sheet dialog ──

function NewSheetDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [note, setNote] = useState('')

  /** close + reset — every close path funnels through here so the next
   *  open always starts with a clean form (no setState-in-effect needed) */
  function close() {
    setNote('')
    onClose()
  }

  const createMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ stockCount: StockCountDTO }>('/api/stock-counts', {
        method: 'POST',
        body: note.trim() !== '' ? { note: note.trim() } : {},
      }),
    onSuccess: (data) => {
      toast.success(
        t('r17.count.created', {
          number: data.stockCount.number,
          lines: data.stockCount.lines.length,
        }),
      )
      void queryClient.invalidateQueries({ queryKey: ['stock-counts'] })
      close()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    createMutation.mutate()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : close())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('r17.count.new')}</DialogTitle>
          <DialogDescription>{t('r17.count.subtitle')}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="sc-note">{t('r17.common.notes')}</Label>
            <Input
              id="sc-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('r17.count.note')}
            />
          </div>
          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={close}>
              {t('r17.common.cancel')}
            </Button>
            <Button type="submit" disabled={createMutation.isPending}>
              {createMutation.isPending ? t('r17.common.loading') : t('r17.common.confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ── count sheet detail dialog ──

type CountRow = {
  line: StockCountDTO['lines'][number]
  /** raw input value ('' when untouched) */
  raw: string
  edited: boolean
  valid: boolean
  /** parsed input (NaN when untouched/invalid) */
  parsed: number
  /** draft-aware counted qty (falls back to the saved value) */
  effective: number | null
  variance: number | null
  valueImpact: number | null
}

function CountDetailDialog({ sheet, onClose }: { sheet: StockCountDTO; onClose: () => void }) {
  const { t, lang } = useI18n()
  const queryClient = useQueryClient()
  const invalidateStock = useInvalidateStock()
  const open = sheet.status === 'open'

  const [draft, setDraft] = useState<Record<number, string>>({})
  const [postConfirmOpen, setPostConfirmOpen] = useState(false)
  const [cancelConfirmOpen, setCancelConfirmOpen] = useState(false)
  // (the dialog is remounted per sheet via key={sheet.id} at the call site,
  //  so `draft` always starts empty for a freshly-opened sheet)

  // draft-aware view model for every line
  const rows: CountRow[] = useMemo(
    () =>
      sheet.lines.map((line) => {
        const raw = draft[line.productId] ?? ''
        const edited = raw.trim() !== ''
        const parsed = edited ? Number(raw) : NaN
        const valid = !edited || (Number.isFinite(parsed) && parsed >= 0)
        const effective = edited && Number.isFinite(parsed) ? parsed : line.countedQty
        const variance = effective === null ? null : round2(effective - line.systemQty)
        return {
          line,
          raw,
          edited,
          valid,
          parsed,
          effective,
          variance,
          valueImpact: variance === null ? null : round2(variance * line.product.cost),
        }
      }),
    [sheet.lines, draft],
  )

  const invalidCount = rows.filter((r) => !r.valid).length
  // lines whose draft value differs from what is saved server-side
  const unsavedRows = rows.filter(
    (r) => r.edited && r.valid && r.line.countedQty !== r.parsed,
  )
  const saveInputs = unsavedRows.map((r) => ({ productId: r.line.productId, countedQty: r.parsed }))
  // what the SERVER would post right now (saved counts only)
  const savedVarianceCount = sheet.lines.filter(
    (l) => l.countedQty !== null && Math.abs(l.countedQty - l.systemQty) > VARIANCE_EPSILON,
  ).length
  const countedCount = rows.filter((r) => r.effective !== null).length
  const liveTotalImpact = round2(rows.reduce((sum, r) => sum + Math.abs(r.valueImpact ?? 0), 0))

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ stockCount: StockCountDTO }>(`/api/stock-counts/${sheet.id}/counts`, {
        method: 'PUT',
        body: { lines: saveInputs },
      }),
    onSuccess: () => {
      toast.success(t('r17.count.saved'))
      void queryClient.invalidateQueries({ queryKey: ['stock-counts'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const postMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ stockCount: StockCountDTO; postedAdjustments: number }>(
        `/api/stock-counts/${sheet.id}/post`,
        { method: 'POST' },
      ),
    onSuccess: (data) => {
      toast.success(t('r17.count.posted', { lines: data.postedAdjustments }))
      void queryClient.invalidateQueries({ queryKey: ['stock-counts'] })
      invalidateStock()
      setPostConfirmOpen(false)
    },
    onError: (err: Error) => {
      toast.error(err.message)
      setPostConfirmOpen(false)
    },
  })

  const cancelMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ stockCount: StockCountDTO }>(`/api/stock-counts/${sheet.id}`, {
        method: 'PATCH',
        body: { action: 'cancel' },
      }),
    onSuccess: () => {
      toast.success(t('r17.count.cancelled'))
      void queryClient.invalidateQueries({ queryKey: ['stock-counts'] })
      setCancelConfirmOpen(false)
    },
    onError: (err: Error) => {
      toast.error(err.message)
      setCancelConfirmOpen(false)
    },
  })

  const anyPending =
    saveMutation.isPending || postMutation.isPending || cancelMutation.isPending
  const canSave = unsavedRows.length > 0 && invalidCount === 0 && !anyPending

  return (
    <Dialog open onOpenChange={(o) => (o ? undefined : onClose())}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-3">
            <span className="font-mono">{sheet.number}</span>
            <ScStatusBadge status={sheet.status} />
          </DialogTitle>
          <DialogDescription>
            {formatDateTime(sheet.createdAt)}
            {sheet.createdBy ? ` · ${L(LOC.by, lang)} ${sheet.createdBy}` : ''}
            {sheet.postedAt ? ` · ${t('r17.count.statusPosted')} ${formatDateTime(sheet.postedAt)}` : ''}
            {sheet.note ? ` · ${sheet.note}` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
            <span className="text-muted-foreground">
              {t('r17.count.counted', { counted: countedCount, total: sheet.lines.length })}
            </span>
            <span className="text-muted-foreground">{t('r17.count.totalImpact')}:</span>
            <span className="font-mono font-semibold">{formatCurrency(liveTotalImpact)}</span>
          </div>

          {open && invalidCount > 0 ? (
            <p className="text-xs text-rose-600">{L(LOC.invalidCounts, lang)}</p>
          ) : null}
          {open && unsavedRows.length > 0 ? (
            <p className="text-xs text-amber-600">{L(LOC.unsavedHint, lang)}</p>
          ) : null}

          <div className="rms-scroll max-h-[28rem] overflow-y-auto rounded-lg border">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead>{t('admin.product')}</TableHead>
                  <TableHead className="text-end">{t('r17.count.systemQty')}</TableHead>
                  <TableHead className="text-end">{t('r17.count.countedQty')}</TableHead>
                  <TableHead className="text-end">{t('r17.count.variance')}</TableHead>
                  <TableHead className="text-end">{t('r17.count.valueImpact')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.line.id}>
                    <TableCell>
                      <p className="font-medium">
                        {localizedName(r.line.product.name, r.line.product.nameAr, lang)}
                      </p>
                      {r.line.product.sku ? (
                        <p className="font-mono text-xs text-muted-foreground">
                          {r.line.product.sku}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-end font-mono">
                      {formatQty(r.line.systemQty)}
                    </TableCell>
                    <TableCell className="text-end">
                      {open ? (
                        <Input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step="any"
                          value={r.raw}
                          onChange={(e) =>
                            setDraft((d) => ({
                              ...d,
                              [r.line.productId]: e.target.value,
                            }))
                          }
                          placeholder="—"
                          aria-label={`${t('r17.count.countedQty')} — ${r.line.product.name}`}
                          className={cn(
                            'ms-auto h-8 w-24 text-end font-mono',
                            !r.valid && 'border-rose-400 focus-visible:ring-rose-400',
                          )}
                        />
                      ) : (
                        <span className="font-mono">
                          {r.line.countedQty === null ? '—' : formatQty(r.line.countedQty)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-end font-mono',
                        r.variance !== null && r.variance < 0 && 'text-rose-600',
                        r.variance !== null && r.variance > 0 && 'text-emerald-600',
                      )}
                    >
                      {r.variance === null
                        ? '—'
                        : `${r.variance > 0 ? '+' : ''}${formatQty(r.variance)}`}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-end font-mono',
                        r.variance !== null && r.variance < 0 && 'text-rose-600',
                        r.variance !== null && r.variance > 0 && 'text-emerald-600',
                      )}
                    >
                      {r.valueImpact === null ? '—' : formatCurrency(r.valueImpact)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>

        {open ? (
          <>
            <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={() => setCancelConfirmOpen(true)}
                disabled={anyPending}
              >
                <Ban />
                {t('r17.count.cancelSheet')}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => saveMutation.mutate()}
                disabled={!canSave}
              >
                {t('r17.count.saveCounts')}
              </Button>
              <Button
                type="button"
                onClick={() => setPostConfirmOpen(true)}
                disabled={anyPending || invalidCount > 0 || unsavedRows.length > 0}
              >
                {t('r17.count.post')}
              </Button>
            </DialogFooter>

            <AlertDialog open={postConfirmOpen} onOpenChange={setPostConfirmOpen}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('r17.count.post')}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('r17.count.postDesc')}{' '}
                    {t('r17.count.postConfirm', { lines: savedVarianceCount })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={postMutation.isPending}>
                    {t('r17.common.cancel')}
                  </AlertDialogCancel>
                  <AlertDialogAction
                    disabled={postMutation.isPending}
                    onClick={(e) => {
                      e.preventDefault() // stay open until the mutation settles
                      postMutation.mutate()
                    }}
                  >
                    {postMutation.isPending ? t('r17.common.loading') : t('r17.common.confirm')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            <AlertDialog open={cancelConfirmOpen} onOpenChange={setCancelConfirmOpen}>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('r17.count.cancelSheet')}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('r17.count.cancelConfirm')}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={cancelMutation.isPending}>
                    {t('r17.common.cancel')}
                  </AlertDialogCancel>
                  <AlertDialogAction
                    disabled={cancelMutation.isPending}
                    className="bg-rose-600 text-white hover:bg-rose-700"
                    onClick={(e) => {
                      e.preventDefault() // stay open until the mutation settles
                      cancelMutation.mutate()
                    }}
                  >
                    {cancelMutation.isPending ? t('r17.common.loading') : t('r17.common.confirm')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

// ─── waste tab ──────────────────────────────────────────────────────

function WasteTab() {
  const { t } = useI18n()
  const [from, setFrom] = useState(() => toDateInputValue(new Date(Date.now() - 30 * 864e5)))
  const [to, setTo] = useState(() => toDateInputValue(new Date()))
  const [logOpen, setLogOpen] = useState(false)

  const wasteQuery = useQuery({
    queryKey: ['waste', from, to],
    queryFn: () => fetcher<{ wasteLogs: WasteLogDTO[] }>(`/api/waste?from=${from}&to=${to}`),
  })
  const reportQuery = useQuery({
    queryKey: ['waste-report', from, to],
    queryFn: () =>
      fetcher<{ report: WasteReport }>(`/api/reports/waste?from=${from}&to=${to}`),
  })

  const entries = wasteQuery.data?.wasteLogs ?? []
  const report = reportQuery.data?.report

  return (
    <div className="space-y-4">
      {/* date-range filter + log action */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="waste-from" className="text-xs text-muted-foreground">
              {t('r17.common.from')}
            </Label>
            <Input
              id="waste-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="h-9 w-40"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="waste-to" className="text-xs text-muted-foreground">
              {t('r17.common.to')}
            </Label>
            <Input
              id="waste-to"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="h-9 w-40"
            />
          </div>
        </div>
        <Button size="sm" onClick={() => setLogOpen(true)}>
          <Plus />
          {t('r17.waste.add')}
        </Button>
      </div>

      {/* waste log */}
      <Card>
        <CardHeader>
          <CardTitle>{t('r17.waste.tab.log')}</CardTitle>
          <CardDescription>
            {entries.length} {t('r17.waste.entries')} · {from} → {to}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {wasteQuery.isLoading ? (
            <ListSkeleton rows={5} />
          ) : wasteQuery.isError ? (
            <QueryError
              message={(wasteQuery.error as Error | null)?.message ?? L(LOC.loadFailed, 'en')}
              onRetry={() => void wasteQuery.refetch()}
            />
          ) : entries.length === 0 ? (
            <EmptyState icon={Trash2} message={t('r17.waste.log.empty')} />
          ) : (
            <div className="rms-scroll max-h-[28rem] overflow-y-auto rounded-lg border">
              <WasteLogTable entries={entries} />
            </div>
          )}
        </CardContent>
      </Card>

      {/* waste report */}
      <Card>
        <CardHeader>
          <CardTitle>{t('r17.waste.tab.report')}</CardTitle>
          <CardDescription>
            {from} → {to}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {reportQuery.isLoading ? (
            <ListSkeleton rows={4} />
          ) : reportQuery.isError ? (
            <QueryError
              message={(reportQuery.error as Error | null)?.message ?? L(LOC.loadFailed, 'en')}
              onRetry={() => void reportQuery.refetch()}
            />
          ) : !report || (report.entries === 0 && report.totalValue === 0) ? (
            <EmptyState icon={Trash2} message={t('r17.waste.noData')} />
          ) : (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
                <div>
                  <p className="text-sm text-muted-foreground">{t('r17.waste.totalValue')}</p>
                  <p className="font-mono text-2xl font-bold text-rose-600">
                    {formatCurrency(report.totalValue)}
                  </p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground">{t('r17.common.total')}</p>
                  <p className="text-2xl font-bold">
                    {report.entries}{' '}
                    <span className="text-sm font-normal text-muted-foreground">
                      {t('r17.waste.entries')}
                    </span>
                  </p>
                </div>
              </div>

              <div className="grid gap-6 lg:grid-cols-2">
                {/* by reason */}
                <div className="space-y-3">
                  <p className="text-sm font-medium">{t('r17.waste.byReason')}</p>
                  <WasteByReason report={report} />
                </div>

                {/* top items */}
                <div className="space-y-3">
                  <p className="text-sm font-medium">{t('r17.waste.topItems')}</p>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-8">#</TableHead>
                        <TableHead>{t('r17.waste.product')}</TableHead>
                        <TableHead className="text-end">{t('r17.common.qty')}</TableHead>
                        <TableHead className="text-end">{t('r17.waste.costValue')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {report.topItems.map((item, i) => (
                        <TableRow key={item.productId}>
                          <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                          <TableCell className="font-medium">{item.name}</TableCell>
                          <TableCell className="text-end font-mono">
                            {formatQty(item.quantity)}
                          </TableCell>
                          <TableCell className="text-end font-mono font-medium">
                            {formatCurrency(item.value)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <LogWasteDialog open={logOpen} onClose={() => setLogOpen(false)} />
    </div>
  )
}

function WasteLogTable({ entries }: { entries: WasteLogDTO[] }) {
  const { t, lang } = useI18n()
  return (
    <Table>
      <TableHeader className="sticky top-0 z-10 bg-card">
        <TableRow>
          <TableHead>{t('common.date')}</TableHead>
          <TableHead>{t('r17.waste.product')}</TableHead>
          <TableHead className="text-end">{t('r17.common.qty')}</TableHead>
          <TableHead>{t('r17.waste.reason')}</TableHead>
          <TableHead className="text-end">{t('r17.waste.costValue')}</TableHead>
          <TableHead className="hidden sm:table-cell">{L(LOC.by, lang)}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((e) => (
          <TableRow key={e.id}>
            <TableCell className="text-muted-foreground">{formatDateTime(e.createdAt)}</TableCell>
            <TableCell>
              <p className="font-medium">
                {localizedName(e.product.name, e.product.nameAr, lang)}
              </p>
              {e.note ? (
                <p className="max-w-48 truncate text-xs text-muted-foreground" title={e.note}>
                  {e.note}
                </p>
              ) : null}
            </TableCell>
            <TableCell className="text-end font-mono text-rose-600">
              −{formatQty(e.quantity)}
            </TableCell>
            <TableCell>
              <WasteReasonBadge reason={e.reason} />
            </TableCell>
            <TableCell className="text-end font-mono font-medium">
              {formatCurrency(e.costValue)}
            </TableCell>
            <TableCell className="hidden text-muted-foreground sm:table-cell">
              {e.user?.name ?? '—'}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function WasteByReason({ report }: { report: WasteReport }) {
  const { t } = useI18n()
  const maxValue = Math.max(...report.byReason.map((r) => r.value), 1)
  return (
    <div className="space-y-3">
      {report.byReason.map((r) => (
        <div key={r.reason} className="space-y-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <WasteReasonBadge reason={r.reason} />
            <span className="text-xs text-muted-foreground">
              {r.entries} {t('r17.waste.entries')} · {formatQty(r.quantity)} {t('r17.common.qty')}
            </span>
            <span className="ms-auto font-mono font-medium">{formatCurrency(r.value)}</span>
          </div>
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            role="img"
            aria-label={`${r.reason}: ${formatCurrency(r.value)}`}
          >
            <div
              className="h-full rounded-full bg-rose-500"
              style={{ width: `${Math.max(0, Math.min(100, (r.value / maxValue) * 100))}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

// ── log waste dialog ──

function LogWasteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, lang } = useI18n()
  const queryClient = useQueryClient()
  const invalidateStock = useInvalidateStock()
  const [productId, setProductId] = useState<number | null>(null)
  const [qtyRaw, setQtyRaw] = useState('')
  const [reason, setReason] = useState<string>('spoilage')
  const [note, setNote] = useState('')

  /** close + reset — every close path funnels through here so the next
   *  open always starts with a clean form (no setState-in-effect needed) */
  function close() {
    setProductId(null)
    setQtyRaw('')
    setReason('spoilage')
    setNote('')
    onClose()
  }

  const productsQuery = useQuery({
    queryKey: ['products', 'stockable'],
    queryFn: () => fetcher<{ products: Product[] }>('/api/products?stockable=1'),
    enabled: open,
  })
  const products = productsQuery.data?.products ?? []
  const selected = products.find((p) => p.id === productId) ?? null

  const qty = Number(qtyRaw)
  const qtyValid = qtyRaw.trim() !== '' && Number.isFinite(qty) && qty > 0
  const costValue = selected && qtyValid ? round2(qty * selected.cost) : 0

  const logMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ wasteLog: WasteLogDTO }>('/api/waste', {
        method: 'POST',
        body: {
          productId,
          quantity: qty,
          reason,
          ...(note.trim() !== '' ? { note: note.trim() } : {}),
        },
      }),
    onSuccess: () => {
      toast.success(t('r17.waste.logged'))
      void queryClient.invalidateQueries({ queryKey: ['waste'] })
      void queryClient.invalidateQueries({ queryKey: ['waste-report'] })
      invalidateStock()
      close()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!selected) {
      toast.error(t('r17.waste.needProduct'))
      return
    }
    if (!qtyValid) {
      toast.error(t('r17.waste.needQty'))
      return
    }
    logMutation.mutate()
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? undefined : close())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('r17.waste.add')}</DialogTitle>
          <DialogDescription>{t('r17.waste.subtitle')}</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={handleSubmit}>
          <div className="space-y-2">
            <Label htmlFor="waste-product">{t('r17.waste.product')}</Label>
            <WasteProductPicker
              value={productId}
              products={products}
              loading={productsQuery.isLoading}
              onSelect={(p) => setProductId(p.id)}
            />
            {selected ? (
              <p className="text-xs text-muted-foreground">
                {L(LOC.inStock, lang)}:{' '}
                <span className="font-mono">{formatQty(selected.stock)}</span> ·{' '}
                {t('r17.common.cost')}:{' '}
                <span className="font-mono">{formatCurrency(selected.cost)}</span>
              </p>
            ) : null}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="waste-qty">{t('r17.common.qty')}</Label>
              <Input
                id="waste-qty"
                type="number"
                inputMode="decimal"
                min={0}
                step="any"
                value={qtyRaw}
                onChange={(e) => setQtyRaw(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="waste-reason">{t('r17.waste.reason')}</Label>
              <Select value={reason} onValueChange={setReason}>
                <SelectTrigger id="waste-reason" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WASTE_REASONS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {t(WASTE_REASON_LABEL[r] ?? `r17.waste.reason.${r}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="waste-note">{t('r17.common.notes')}</Label>
            <Input
              id="waste-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('r17.purchasing.suppliers.notes')}
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border bg-muted/40 px-3 py-2 text-sm">
            <span className="text-muted-foreground">{t('r17.waste.costValue')}</span>
            <span className="font-mono text-base font-semibold">
              {formatCurrency(costValue)}
            </span>
          </div>

          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" onClick={close}>
              {t('r17.common.cancel')}
            </Button>
            <Button type="submit" disabled={logMutation.isPending || !selected || !qtyValid}>
              {logMutation.isPending ? t('r17.common.loading') : t('r17.common.confirm')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ── searchable product picker (Popover + Command combobox) ─────────

function WasteProductPicker({
  value,
  products,
  loading,
  onSelect,
}: {
  value: number | null
  products: Product[]
  loading: boolean
  onSelect: (p: Product) => void
}) {
  const { t, lang } = useI18n()
  const [open, setOpen] = useState(false)
  const selected = products.find((p) => p.id === value) ?? null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={loading}
          className="w-full justify-between font-normal"
        >
          <span className="truncate">
            {selected
              ? localizedName(selected.name, selected.nameAr, lang)
              : loading
                ? t('r17.common.loading')
                : t('r17.po.selectProduct')}
          </span>
          <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(24rem,calc(100vw-3rem))] p-0" align="start">
        <Command>
          <CommandInput placeholder={t('r17.common.search')} />
          <CommandList className="max-h-64">
            <CommandEmpty>{L(LOC.noProductsFound, lang)}</CommandEmpty>
            <CommandGroup>
              {products.map((p) => (
                <CommandItem
                  key={p.id}
                  value={`${p.name} ${p.sku ?? ''} ${p.nameAr ?? ''}`}
                  onSelect={() => {
                    onSelect(p)
                    setOpen(false)
                  }}
                >
                  <Check
                    className={cn('size-4 shrink-0', value === p.id ? 'opacity-100' : 'opacity-0')}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {localizedName(p.name, p.nameAr, lang)}
                  </span>
                  <span className="ms-auto shrink-0 font-mono text-xs text-muted-foreground">
                    {formatQty(p.stock)} {L(LOC.inStock, lang)}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
