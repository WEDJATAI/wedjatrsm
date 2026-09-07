'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  Check,
  CreditCard,
  Loader2,
  Plus,
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { toast } from 'sonner'
import { apiFetch } from '@/lib/api'
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS } from '@/lib/constants'
import { formatCurrency, formatQty } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { Order } from '@/lib/types'
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

export default function PaymentModal({ order, open, onOpenChange, onSuccess }: PaymentModalProps) {
  const [tab, setTab] = useState<SplitTab>('single')
  const [submitting, setSubmitting] = useState(false)

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
        label: `${formatQty(it.quantity)} × ${it.product?.name ?? 'Item'}`,
        total: round2(it.quantity * it.unitPrice),
      })),
    [order.items],
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
        toast.success('Order paid & closed ✓')
        onSuccess(result.order, true)
        onOpenChange(false)
      } else {
        toast.success(`Payment recorded — remaining ${formatCurrency(result.remaining)}`)
        onSuccess(result.order, false)
        onOpenChange(false)
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Payment failed')
    } finally {
      setSubmitting(false)
    }
  }

  const singleExceeds = tab === 'single' && parseAmount(singleRow.amount) > round2(remaining + 0.01)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Take payment</DialogTitle>
          <DialogDescription>
            Order #{order.id}
            {order.table?.name ? ` — ${order.table.name}` : ' — Takeaway'}
          </DialogDescription>
        </DialogHeader>

        {/* Summary */}
        <div className="grid grid-cols-3 gap-2 rounded-lg bg-muted/50 p-3 text-center">
          <div>
            <p className="text-xs text-muted-foreground">Total</p>
            <p className="text-sm font-semibold tabular-nums">{formatCurrency(order.totalAmount)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Paid</p>
            <p className="text-sm font-semibold tabular-nums text-emerald-600">
              {formatCurrency(order.paidAmount)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Remaining</p>
            <p className="text-primary text-2xl font-bold tabular-nums">
              {formatCurrency(remaining)}
            </p>
          </div>
        </div>

        <Tabs value={tab} onValueChange={(v) => setTab(v as SplitTab)}>
          <TabsList className="grid h-10 w-full grid-cols-4">
            <TabsTrigger value="single" className="text-xs sm:text-sm">Single</TabsTrigger>
            <TabsTrigger value="equal" className="text-xs sm:text-sm">Equal Split</TabsTrigger>
            <TabsTrigger value="items" className="text-xs sm:text-sm">By Items</TabsTrigger>
            <TabsTrigger value="custom" className="text-xs sm:text-sm">Custom</TabsTrigger>
          </TabsList>

          {/* ── Single ── */}
          <TabsContent value="single" className="space-y-2 pt-3">
            <PayRow
              label="Payment"
              method={singleRow.method}
              onMethodChange={(m) => setSingleRow((r) => ({ ...r, method: m }))}
              amountStr={singleRow.amount}
              onAmountChange={(v) => setSingleRow((r) => ({ ...r, amount: v }))}
              reference={singleRow.reference}
              onReferenceChange={(v) => setSingleRow((r) => ({ ...r, reference: v }))}
              editable
              error={
                singleExceeds
                  ? `Exceeds remaining by ${formatCurrency(round2(parseAmount(singleRow.amount) - remaining))}`
                  : undefined
              }
            />
          </TabsContent>

          {/* ── Equal Split ── */}
          <TabsContent value="equal" className="space-y-3 pt-3">
            <div className="flex items-center gap-3 rounded-lg border p-2.5">
              <Users className="size-4 text-muted-foreground" />
              <span className="flex-1 text-sm font-medium">Split between</span>
              <Input
                type="number"
                min={2}
                max={12}
                value={eqPayers}
                onChange={(e) => setEqPayers(clampPayers(parseInt(e.target.value, 10) || 2, 2, 12))}
                className="h-10 w-16 text-center tabular-nums"
              />
              <span className="text-sm text-muted-foreground">payers</span>
            </div>
            {eqAmounts.map((amount, i) => (
              <PayRow
                key={i}
                label={`Payer ${i + 1}`}
                method={eqMethods[i] ?? 'cash'}
                onMethodChange={(m) => setEqMethods((prev) => ({ ...prev, [i]: m }))}
                amount={amount}
              />
            ))}
            <p className="text-center text-xs text-muted-foreground">
              Parts total: <span className="font-semibold tabular-nums">{formatCurrency(sum)}</span>
            </p>
          </TabsContent>

          {/* ── By Items ── */}
          <TabsContent value="items" className="space-y-3 pt-3">
            <div className="flex items-center gap-3 rounded-lg border p-2.5">
              <Users className="size-4 text-muted-foreground" />
              <span className="flex-1 text-sm font-medium">Assign items to</span>
              <Input
                type="number"
                min={2}
                max={6}
                value={itPayers}
                onChange={(e) => setItPayers(clampPayers(parseInt(e.target.value, 10) || 2, 2, 6))}
                className="h-10 w-16 text-center tabular-nums"
              />
              <span className="text-sm text-muted-foreground">payers</span>
            </div>

            <div className="space-y-1.5">
              {itemLines.map((line) => {
                const active = Math.min(assignments[line.id] ?? 0, itPayers - 1)
                return (
                  <div
                    key={line.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2.5"
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
                              ? 'border-primary bg-primary text-primary-foreground'
                              : 'border-border bg-muted/50 text-muted-foreground hover:border-primary/40',
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
                Each payer pays
              </p>
              {itAmounts.map((amount, i) => (
                <PayRow
                  key={i}
                  label={`Payer ${i + 1}`}
                  method={itMethods[i] ?? 'cash'}
                  onMethodChange={(m) => setItMethods((prev) => ({ ...prev, [i]: m }))}
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
                label={`Payment ${i + 1}`}
                method={row.method}
                onMethodChange={(m) =>
                  setCustomRows((rows) => rows.map((r) => (r.id === row.id ? { ...r, method: m } : r)))
                }
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
            <Button variant="outline" className="h-11 w-full border-dashed" onClick={addCustomRow}>
              <Plus /> Add payment
            </Button>
          </TabsContent>
        </Tabs>

        {/* Live total + submit */}
        <div className="space-y-2 border-t pt-3">
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
                <AlertCircle className="size-4" /> Exceeds remaining by{' '}
                {formatCurrency(Math.abs(diff))}
              </>
            ) : exact ? (
              <>
                <Check className="size-4" /> Exact
              </>
            ) : (
              <>Remaining after: {formatCurrency(round2(remaining - sum))}</>
            )}
          </div>
          <Button
            className="h-12 w-full text-base"
            disabled={!canSubmit}
            onClick={handleSubmit}
          >
            {submitting ? <Loader2 className="animate-spin" /> : <CreditCard />}
            Charge {formatCurrency(sum)}
          </Button>
        </div>

        {/* Receipt is rendered by the parent (pos-view) after full payment */}
      </DialogContent>
    </Dialog>
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
  onMethodChange,
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
  onMethodChange: (m: string) => void
  amount?: number
  amountStr?: string
  onAmountChange?: (v: string) => void
  reference?: string
  onReferenceChange?: (v: string) => void
  onRemove?: () => void
  editable?: boolean
  error?: string
}) {
  return (
    <div className="rounded-lg border p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        {onRemove && (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground hover:text-destructive"
            onClick={onRemove}
            title="Remove payment"
          >
            <X className="size-4" />
          </Button>
        )}
      </div>
      <div className="mt-1.5 flex gap-2">
        <Select value={method} onValueChange={onMethodChange}>
          <SelectTrigger className="h-10 flex-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAYMENT_METHODS.map((m) => (
              <SelectItem key={m} value={m}>
                {PAYMENT_METHOD_LABELS[m]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {editable ? (
          <Input
            type="number"
            min={0}
            step={0.01}
            inputMode="decimal"
            value={amountStr}
            onChange={(e) => onAmountChange?.(e.target.value)}
            className="h-10 w-28 text-right text-sm font-semibold tabular-nums"
            aria-label={`${label} amount`}
          />
        ) : (
          <div
            className="flex h-10 w-28 items-center justify-center rounded-md border bg-muted/40 text-sm font-semibold tabular-nums"
            aria-label={`${label} amount`}
          >
            {formatCurrency(amount ?? 0)}
          </div>
        )}
      </div>
      {method === 'card' && onReferenceChange && (
        <Input
          value={reference ?? ''}
          onChange={(e) => onReferenceChange(e.target.value)}
          placeholder="Ref # (optional)"
          className="mt-1.5 h-10"
        />
      )}
      {error && <p className="mt-1.5 text-xs font-medium text-destructive">{error}</p>}
    </div>
  )
}
