'use client'

import { useEffect, useMemo, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  AlertCircle,
  Banknote,
  Check,
  CreditCard,
  Loader2,
  MoreHorizontal,
  Plus,
  Printer,
  Users,
  X,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toast } from 'sonner'
import { apiFetch } from '@/lib/api'
import { PAYMENT_METHODS } from '@/lib/constants'
import { formatCurrency, formatQty } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import type { Order } from '@/lib/types'
import CheckModal, { type CheckSplitRow } from './check-modal'
import { newDraftKey, parseAmount, round2 } from './pos-utils'

type PaymentModalProps = {
  order: Order
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: (order: Order, closed: boolean) => void
}

type PaymentResult = {
  order: Order
  paidAmount: number
  remaining: number
  closed: boolean
}

type EditableRow = {
  id: string
  method: string
  amount: string
  reference: string
}

type SubmitRow = { method: string; amount: number; reference?: string }

type SplitTab = 'single' | 'equal' | 'items' | 'custom'

const METHOD_META: Record<string, { labelKey: string; icon: LucideIcon }> = {
  cash: { labelKey: 'status.payment.cash', icon: Banknote },
  card: { labelKey: 'status.payment.card', icon: CreditCard },
  other: { labelKey: 'status.payment.other', icon: MoreHorizontal },
}

export default function PaymentModal({ order, open, onOpenChange, onSuccess }: PaymentModalProps) {
  const { t } = useI18n()
  const [tab, setTab] = useState<SplitTab>('single')
  const [submitting, setSubmitting] = useState(false)
  const [checkOpen, setCheckOpen] = useState(false)

  // Which payment row the method tiles currently target.
  const [activeIdx, setActiveIdx] = useState(0)

  const [singleRow, setSingleRow] = useState<EditableRow>({ id: 'single', method: 'cash', amount: '', reference: '' })
  const [customRows, setCustomRows] = useState<EditableRow[]>([])

  const [eqPayers, setEqPayers] = useState(2)
  const [eqMethods, setEqMethods] = useState<Record<number, string>>({})

  const [itPayers, setItPayers] = useState(2)
  const [itMethods, setItMethods] = useState<Record<number, string>>({})
  const [assignments, setAssignments] = useState<Record<number, number>>({})

  const remaining = round2(Math.max(0, order.remainingAmount))

  // Reset state whenever the modal opens for (a new) order.
  useEffect(() => {
    if (!open) return
    const rem = round2(Math.max(0, order.remainingAmount))
    setTab('single')
    setSingleRow({ id: 'single', method: 'cash', amount: String(rem), reference: '' })
    setCustomRows([{ id: newDraftKey(), method: 'cash', amount: String(rem), reference: '' }])
    setEqPayers(2)
    setEqMethods({})
    setItPayers(2)
    setItMethods({})
    setAssignments({})
    setSubmitting(false)
    setActiveIdx(0)
    setCheckOpen(false)
  }, [open, order.id, order.remainingAmount])

  // ── Derived payment rows per tab ──────────────────────────────────
  const eqAmounts = useMemo(() => {
    const part = round2(remaining / eqPayers)
    const amounts = Array.from({ length: eqPayers }, () => part)
    const others = round2(part * (eqPayers - 1))
    amounts[eqPayers - 1] = round2(Math.max(0, remaining - others))
    return amounts
  }, [remaining, eqPayers])

  const itemLines = useMemo(
    () =>
      order.items.map((it) => ({
        id: it.id,
        label: `${formatQty(it.quantity)} × ${it.product?.name ?? t('pos.item')}`,
        total: round2(it.quantity * it.unitPrice),
      })),
    [order.items, t],
  )

  const itAmounts = useMemo(() => {
    const subtotal = round2(order.subtotalAmount)
    const rawTotals = new Array<number>(itPayers).fill(0)
    for (const line of itemLines) {
      const payer = assignments[line.id] ?? 0
      if (payer < itPayers) rawTotals[payer] = round2(rawTotals[payer] + line.total)
    }
    const amounts: number[] = []
    let allocated = 0
    for (let i = 0; i < itPayers; i++) {
      if (i === itPayers - 1) {
        amounts.push(round2(Math.max(0, remaining - allocated)))
      } else {
        const share = subtotal > 0 ? round2((rawTotals[i] / subtotal) * remaining) : 0
        amounts.push(share)
        allocated = round2(allocated + share)
      }
    }
    return amounts
  }, [itemLines, assignments, itPayers, remaining, order.subtotalAmount])

  const submitRows: SubmitRow[] = useMemo(() => {
    if (tab === 'single') {
      return [toSubmitRow(singleRow)]
    }
    if (tab === 'equal') {
      return eqAmounts.map((amount, i) => ({
        method: eqMethods[i] ?? 'cash',
        amount,
      }))
    }
    if (tab === 'items') {
      return itAmounts.map((amount, i) => ({
        method: itMethods[i] ?? 'cash',
        amount,
      }))
    }
    return customRows.map(toSubmitRow)
  }, [tab, singleRow, customRows, eqAmounts, eqMethods, itAmounts, itMethods])

  const sum = round2(submitRows.reduce((s, r) => s + r.amount, 0))
  const diff = round2(sum - remaining)
  const exceeds = diff > 0.01
  const exact = Math.abs(diff) <= 0.01
  const canSubmit = !submitting && remaining > 0 && sum > 0 && !exceeds

  // ── Active row / method tiles ─────────────────────────────────────
  const rowCount =
    tab === 'single' ? 1 : tab === 'equal' ? eqPayers : tab === 'items' ? itPayers : customRows.length
  const safeActiveIdx = Math.min(activeIdx, Math.max(0, rowCount - 1))

  const activeRowLabel =
    tab === 'single'
      ? t('pos.payment')
      : tab === 'equal' || tab === 'items'
        ? t('pos.payer', { n: safeActiveIdx + 1 })
        : t('pos.paymentN', { n: safeActiveIdx + 1 })

  const currentMethodAt = (index: number): string => {
    if (tab === 'single') return singleRow.method
    if (tab === 'equal') return eqMethods[index] ?? 'cash'
    if (tab === 'items') return itMethods[index] ?? 'cash'
    return customRows[index]?.method ?? 'cash'
  }

  const setMethodAt = (index: number, m: string) => {
    if (tab === 'single') {
      setSingleRow((r) => ({ ...r, method: m }))
    } else if (tab === 'equal') {
      setEqMethods((prev) => ({ ...prev, [index]: m }))
    } else if (tab === 'items') {
      setItMethods((prev) => ({ ...prev, [index]: m }))
    } else {
      setCustomRows((rows) => rows.map((r, i) => (i === index ? { ...r, method: m } : r)))
    }
  }

  const handleTabChange = (v: string) => {
    setTab(v as SplitTab)
    setActiveIdx(0)
  }

  // ── Guest check rows mirroring the current split configuration ────
  const checkRows: CheckSplitRow[] = useMemo(() => {
    if (tab === 'single') {
      const amount = parseAmount(singleRow.amount) || remaining
      return [{ label: t('pos.fullBill'), amount, method: singleRow.method }]
    }
    if (tab === 'equal') {
      return eqAmounts.map((amount, i) => ({
        label: t('pos.partOf', { i: i + 1, n: eqPayers }),
        amount,
        method: eqMethods[i] ?? 'cash',
      }))
    }
    if (tab === 'items') {
      return itAmounts.map((amount, i) => ({
        label: t('pos.payer', { n: i + 1 }),
        amount,
        method: itMethods[i] ?? 'cash',
      }))
    }
    return customRows.map((r, i) => ({
      label: t('pos.paymentN', { n: i + 1 }),
      amount: parseAmount(r.amount),
      method: r.method,
    }))
  }, [tab, singleRow, customRows, eqAmounts, eqMethods, eqPayers, itAmounts, itMethods, remaining, t])

  // ── Handlers ──────────────────────────────────────────────────────
  const clampPayers = (raw: number, min: number, max: number) => {
    const n = Math.round(Number.isFinite(raw) ? raw : min)
    return Math.min(max, Math.max(min, n))
  }

  const setAssignment = (itemId: number, payer: number) =>
    setAssignments((prev) => ({ ...prev, [itemId]: payer }))

  const addCustomRow = () => {
    const current = round2(customRows.reduce((s, r) => s + parseAmount(r.amount), 0))
    const next = round2(Math.max(0, remaining - current))
    setCustomRows((rows) => [...rows, { id: newDraftKey(), method: 'cash', amount: String(next), reference: '' }])
  }

  const handleSubmit = async () => {
    const payments = submitRows
      .map((r) => ({ ...r, amount: round2(r.amount) }))
      .filter((r) => r.amount > 0)
      .map((r) => ({
        method: r.method,
        amount: r.amount,
        ...(r.method === 'card' && r.reference?.trim() ? { reference: r.reference.trim() } : {}),
      }))
    if (payments.length === 0) return
    setSubmitting(true)
    try {
      const result = await apiFetch<PaymentResult>(`/api/orders/${order.id}/payments`, {
        method: 'POST',
        body: { payments },
      })
      if (result.closed) {
        toast.success(t('pos.paidClosedToast'))
        onSuccess(result.order, true)
        onOpenChange(false)
      } else {
        toast.success(t('pos.paymentRecordedToast', { amount: formatCurrency(result.remaining) }))
        onSuccess(result.order, false)
        onOpenChange(false)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('pos.paymentFailedToast'))
    } finally {
      setSubmitting(false)
    }
  }

  const singleExceeds = tab === 'single' && parseAmount(singleRow.amount) > round2(remaining + 0.01)

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {t('pos.payment')} · {order.table?.name ?? t('common.takeaway')} ·{' '}
              {t('common.order')} #{order.id}
            </DialogTitle>
            <DialogDescription>{t('pos.paymentDesc')}</DialogDescription>
          </DialogHeader>

          {/* Summary */}
          <div className="grid grid-cols-3 gap-2 rounded-xl border border-[#E2E2E0] bg-white p-3 text-center shadow-sm">
            <div>
              <p className="text-xs text-muted-foreground">{t('money.total')}</p>
              <p className="text-sm font-semibold tabular-nums">{formatCurrency(order.totalAmount)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t('money.paid')}</p>
              <p className="text-sm font-semibold tabular-nums text-emerald-600">
                {formatCurrency(order.paidAmount)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t('money.remaining')}</p>
              <p className="text-primary text-2xl font-bold tabular-nums">
                {formatCurrency(remaining)}
              </p>
            </div>
          </div>

          {/* Method tiles — apply to the active row below */}
          <div className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('pos.methodAppliesTo')} <span className="text-[#714B67]">{activeRowLabel}</span>
            </p>
            <div className="grid grid-cols-3 gap-2">
              {PAYMENT_METHODS.map((m) => {
                const meta = METHOD_META[m] ?? { labelKey: `status.payment.${m}`, icon: MoreHorizontal }
                const Icon = meta.icon
                const active = currentMethodAt(safeActiveIdx) === m
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMethodAt(safeActiveIdx, m)}
                    aria-pressed={active}
                    className={cn(
                      'flex h-16 flex-col items-center justify-center gap-1 rounded-xl border-2 text-sm font-semibold transition active:scale-95',
                      active
                        ? 'border-[#714B67] bg-[#714B67]/10 text-[#714B67]'
                        : 'border-[#E2E2E0] bg-white text-stone-600 hover:border-[#714B67]/40',
                    )}
                  >
                    <Icon className="size-6" aria-hidden />
                    {t(meta.labelKey)}
                  </button>
                )
              })}
            </div>
          </div>

          <Tabs value={tab} onValueChange={handleTabChange}>
            <TabsList className="grid h-10 w-full grid-cols-4">
              <TabsTrigger value="single" className="text-xs sm:text-sm">
                {t('pos.tabSingle')}
              </TabsTrigger>
              <TabsTrigger value="equal" className="text-xs sm:text-sm">
                {t('pos.tabEqual')}
              </TabsTrigger>
              <TabsTrigger value="items" className="text-xs sm:text-sm">
                {t('pos.tabItems')}
              </TabsTrigger>
              <TabsTrigger value="custom" className="text-xs sm:text-sm">
                {t('pos.tabCustom')}
              </TabsTrigger>
            </TabsList>

            {/* ── Single ── */}
            <TabsContent value="single" className="space-y-2 pt-3">
              <PayRow
                label={t('pos.payment')}
                method={singleRow.method}
                active
                amountStr={singleRow.amount}
                onAmountChange={(v) => setSingleRow((r) => ({ ...r, amount: v }))}
                reference={singleRow.reference}
                onReferenceChange={(v) => setSingleRow((r) => ({ ...r, reference: v }))}
                editable
                error={
                  singleExceeds
                    ? t('pos.exceedsBy', {
                        amount: formatCurrency(round2(parseAmount(singleRow.amount) - remaining)),
                      })
                    : undefined
                }
              />
            </TabsContent>

            {/* ── Equal Split ── */}
            <TabsContent value="equal" className="space-y-3 pt-3">
              <div className="flex items-center gap-3 rounded-xl border border-[#E2E2E0] bg-white p-2.5">
                <Users className="size-4 text-muted-foreground" />
                <span className="flex-1 text-sm font-medium">{t('pos.splitBetween')}</span>
                <Input
                  type="number"
                  min={2}
                  max={12}
                  value={eqPayers}
                  onChange={(e) => setEqPayers(clampPayers(parseInt(e.target.value, 10) || 2, 2, 12))}
                  className="h-10 w-16 text-center tabular-nums"
                />
                <span className="text-sm text-muted-foreground">{t('pos.payers')}</span>
              </div>
              {eqAmounts.map((amount, i) => (
                <PayRow
                  key={i}
                  label={t('pos.payer', { n: i + 1 })}
                  method={eqMethods[i] ?? 'cash'}
                  active={safeActiveIdx === i}
                  onActivate={() => setActiveIdx(i)}
                  amount={amount}
                />
              ))}
              <p className="text-center text-xs text-muted-foreground">
                {t('pos.partsTotal')}{' '}
                <span className="font-semibold tabular-nums">{formatCurrency(sum)}</span>
              </p>
            </TabsContent>

            {/* ── By Items ── */}
            <TabsContent value="items" className="space-y-3 pt-3">
              <div className="flex items-center gap-3 rounded-xl border border-[#E2E2E0] bg-white p-2.5">
                <Users className="size-4 text-muted-foreground" />
                <span className="flex-1 text-sm font-medium">{t('pos.assignItemsTo')}</span>
                <Input
                  type="number"
                  min={2}
                  max={6}
                  value={itPayers}
                  onChange={(e) => setItPayers(clampPayers(parseInt(e.target.value, 10) || 2, 2, 6))}
                  className="h-10 w-16 text-center tabular-nums"
                />
                <span className="text-sm text-muted-foreground">{t('pos.payers')}</span>
              </div>

              <div className="space-y-1.5">
                {itemLines.map((line) => {
                  const active = Math.min(assignments[line.id] ?? 0, itPayers - 1)
                  return (
                    <div
                      key={line.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[#E2E2E0] bg-white p-2.5"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{line.label}</p>
                        <p className="text-xs text-muted-foreground tabular-nums">
                          {formatCurrency(line.total)}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {Array.from({ length: itPayers }, (_, p) => (
                          <button
                            key={p}
                            type="button"
                            onClick={() => setAssignment(line.id, p)}
                            className={cn(
                              'h-9 min-w-9 rounded-md border px-2 text-xs font-semibold transition-colors',
                              p === active
                                ? 'border-[#714B67] bg-[#714B67] text-white'
                                : 'border-border bg-muted/50 text-muted-foreground hover:border-[#714B67]/40',
                            )}
                            aria-pressed={p === active}
                          >
                            P{p + 1}
                          </button>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>

              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('pos.eachPayerPays')}
                </p>
                {itAmounts.map((amount, i) => (
                  <PayRow
                    key={i}
                    label={t('pos.payer', { n: i + 1 })}
                    method={itMethods[i] ?? 'cash'}
                    active={safeActiveIdx === i}
                    onActivate={() => setActiveIdx(i)}
                    amount={amount}
                  />
                ))}
              </div>
            </TabsContent>

            {/* ── Custom ── */}
            <TabsContent value="custom" className="space-y-2 pt-3">
              {customRows.map((row, i) => (
                <PayRow
                  key={row.id}
                  label={t('pos.paymentN', { n: i + 1 })}
                  method={row.method}
                  active={safeActiveIdx === i}
                  onActivate={() => setActiveIdx(i)}
                  amountStr={row.amount}
                  onAmountChange={(v) =>
                    setCustomRows((rows) => rows.map((r) => (r.id === row.id ? { ...r, amount: v } : r)))
                  }
                  reference={row.reference}
                  onReferenceChange={(v) =>
                    setCustomRows((rows) => rows.map((r) => (r.id === row.id ? { ...r, reference: v } : r)))
                  }
                  onRemove={
                    customRows.length > 1
                      ? () => setCustomRows((rows) => rows.filter((r) => r.id !== row.id))
                      : undefined
                  }
                  editable
                />
              ))}
              <Button variant="outline" className="h-11 w-full rounded-xl border-dashed" onClick={addCustomRow}>
                <Plus /> {t('pos.addPayment')}
              </Button>
            </TabsContent>
          </Tabs>

          {/* Live total + submit */}
          <div className="space-y-2 border-t border-[#E2E2E0] pt-3">
            <div
              className={cn(
                'flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium',
                exceeds
                  ? 'bg-rose-50 text-rose-700'
                  : exact
                    ? 'bg-emerald-50 text-emerald-700'
                    : 'bg-amber-50 text-amber-700',
              )}
            >
              {exceeds ? (
                <>
                  <AlertCircle className="size-4" /> {t('pos.exceedsBy', { amount: formatCurrency(Math.abs(diff)) })}
                </>
              ) : exact ? (
                <>
                  <Check className="size-4" /> {t('pos.exact')}
                </>
              ) : (
                <>
                  {t('pos.remainingAfter', { amount: formatCurrency(round2(remaining - sum)) })}
                </>
              )}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="h-12 flex-1 rounded-xl border-[#E2E2E0]"
                onClick={() => setCheckOpen(true)}
                title={t('pos.printCheckPaymentHint')}
              >
                <Printer />
                <span className="hidden sm:inline">{t('pos.printCheck')}</span>
              </Button>
              <Button
                className="h-12 flex-[1.8] rounded-xl bg-emerald-600 text-base font-semibold text-white hover:bg-emerald-700"
                disabled={!canSubmit}
                onClick={handleSubmit}
              >
                {submitting ? <Loader2 className="animate-spin" /> : <CreditCard />}
                {t('pos.charge')} {formatCurrency(sum)}
              </Button>
            </div>
          </div>

          {/* Receipt is rendered by the parent (pos-view) after full payment */}
        </DialogContent>
      </Dialog>

      {/* Guest check for the CURRENT split configuration — printing does NOT
          record payments; the payment modal stays open behind it. */}
      <CheckModal order={order} open={checkOpen} onOpenChange={setCheckOpen} rows={checkRows} />
    </>
  )
}

function toSubmitRow(r: EditableRow): SubmitRow {
  return {
    method: r.method,
    amount: parseAmount(r.amount),
    ...(r.method === 'card' && r.reference.trim() ? { reference: r.reference.trim() } : {}),
  }
}

function PayRow({
  label,
  method,
  active = false,
  onActivate,
  amount,
  amountStr,
  onAmountChange,
  reference,
  onReferenceChange,
  onRemove,
  editable,
  error,
}: {
  label: string
  method: string
  /** Whether the method tiles currently target this row. */
  active?: boolean
  onActivate?: () => void
  amount?: number
  amountStr?: string
  onAmountChange?: (v: string) => void
  reference?: string
  onReferenceChange?: (v: string) => void
  onRemove?: () => void
  editable?: boolean
  error?: string
}) {
  const { t } = useI18n()
  const meta = METHOD_META[method] ?? { labelKey: `status.payment.${method}`, icon: MoreHorizontal }
  const Icon = meta.icon

  return (
    <div
      className={cn(
        'cursor-pointer rounded-xl border p-2.5 transition-colors',
        active ? 'border-[#714B67] ring-1 ring-[#714B67]' : 'border-[#E2E2E0] bg-white',
      )}
      onClick={() => onActivate?.()}
      title={onActivate ? t('pos.selectRowHint') : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span className="text-sm font-medium">{label}</span>
          <span
            className={cn(
              'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold',
              active ? 'bg-[#714B67] text-white' : 'bg-[#714B67]/10 text-[#714B67]',
            )}
          >
            <Icon className="size-3" aria-hidden /> {t(meta.labelKey)}
          </span>
        </span>
        {onRemove && (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
            onClick={(e) => {
              e.stopPropagation()
              onRemove()
            }}
            title={t('pos.removePayment')}
          >
            <X className="size-4" />
          </Button>
        )}
      </div>
      <div className="mt-1.5 flex gap-2">
        {editable ? (
          <Input
            type="number"
            min={0}
            step={0.01}
            inputMode="decimal"
            value={amountStr}
            onChange={(e) => onAmountChange?.(e.target.value)}
            className="h-10 w-28 text-right text-sm font-semibold tabular-nums"
            aria-label={t('pos.amountAria', { label })}
          />
        ) : (
          <div
            className="flex h-10 w-28 items-center justify-center rounded-md border bg-muted/40 text-sm font-semibold tabular-nums"
            aria-label={t('pos.amountAria', { label })}
          >
            {formatCurrency(amount ?? 0)}
          </div>
        )}
      </div>
      {method === 'card' && onReferenceChange && (
        <Input
          value={reference ?? ''}
          onChange={(e) => onReferenceChange(e.target.value)}
          placeholder={t('pos.refOptional')}
          className="mt-1.5 h-10"
        />
      )}
      {error && <p className="mt-1.5 text-xs font-medium text-destructive">{error}</p>}
    </div>
  )
}
