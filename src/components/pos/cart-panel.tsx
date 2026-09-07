'use client'

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Ban,
  Check,
  CreditCard,
  Loader2,
  Minus,
  Pencil,
  Plus,
  Send,
  ShoppingBag,
  StickyNote,
  Trash2,
  X,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { toast } from 'sonner'
import { apiFetch } from '@/lib/api'
import { COURSES, COURSE_LABELS, ITEM_STATUS_LABELS, ROLE_LABELS, TAX_RATE } from '@/lib/constants'
import { formatCurrency, formatQty } from '@/lib/format'
import { cn } from '@/lib/utils'
import type { Order, OrderItem } from '@/lib/types'
import { computeCartTotals, round2, type DraftItem } from './pos-utils'

type CartPanelProps = {
  order: Order | null
  orderLoading?: boolean
  draft: DraftItem[]
  table: { id: number | null; name: string }
  onDraftChange: (draft: DraftItem[]) => void
  onSend: () => void
  onPay: () => void
  onCancel: () => void
  canCancel?: boolean
  sending?: boolean
  userRole?: string
}

const STATUS_CHIP: Record<string, string> = {
  new: 'bg-zinc-100 text-zinc-500',
  preparing: 'bg-amber-100 text-amber-700 animate-pulse',
  ready: 'bg-emerald-100 text-emerald-700',
  served: 'bg-muted text-muted-foreground',
}

export default function CartPanel({
  order,
  orderLoading = false,
  draft,
  table,
  onDraftChange,
  onSend,
  onPay,
  onCancel,
  canCancel = false,
  sending = false,
  userRole,
}: CartPanelProps) {
  const queryClient = useQueryClient()
  const orderId = order?.id ?? null

  const [editing, setEditing] = useState<DraftItem | null>(null)
  const [editQty, setEditQty] = useState('1')
  const [editNotes, setEditNotes] = useState('')
  const [editCourse, setEditCourse] = useState('main')

  const [discountOpen, setDiscountOpen] = useState(false)
  const [discountTab, setDiscountTab] = useState<'percent' | 'fixed'>('percent')
  const [percentInput, setPercentInput] = useState('')
  const [fixedInput, setFixedInput] = useState('')

  const totals = computeCartTotals(order, draft)
  const noItems = (order?.items.length ?? 0) + draft.length === 0

  // ── Server mutations (sent items) ─────────────────────────────────
  const markServed = useMutation({
    mutationFn: (itemId: number) =>
      apiFetch<{ item: OrderItem }>(`/api/order-items/${itemId}`, {
        method: 'PUT',
        body: { status: 'served' },
      }),
    onSuccess: async (data) => {
      toast.success(`${data.item.product?.name ?? 'Item'} marked served`)
      await queryClient.invalidateQueries({ queryKey: ['pos-order'] })
      await queryClient.invalidateQueries({ queryKey: ['orders'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const removeItem = useMutation({
    mutationFn: (itemId: number) => {
      if (orderId == null) throw new Error('No active order')
      return apiFetch<{ order: Order }>(`/api/orders/${orderId}`, {
        method: 'PUT',
        body: { removeItemIds: [itemId] },
      })
    },
    onSuccess: async ({ order: updated }) => {
      queryClient.setQueryData(['pos-order', updated.id], { order: updated })
      await queryClient.invalidateQueries({ queryKey: ['orders'] })
      await queryClient.invalidateQueries({ queryKey: ['floorplans'] })
      await queryClient.invalidateQueries({ queryKey: ['tables-status'] })
      toast.success('Item removed from order')
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const applyDiscount = useMutation({
    mutationFn: (discountAmount: number) => {
      if (orderId == null) throw new Error('No active order')
      return apiFetch<{ order: Order }>(`/api/orders/${orderId}`, {
        method: 'PUT',
        body: { discountAmount },
      })
    },
    onSuccess: async ({ order: updated }) => {
      queryClient.setQueryData(['pos-order', updated.id], { order: updated })
      await queryClient.invalidateQueries({ queryKey: ['orders'] })
      await queryClient.invalidateQueries({ queryKey: ['floorplans'] })
      await queryClient.invalidateQueries({ queryKey: ['tables-status'] })
      toast.success('Discount updated')
      setDiscountOpen(false)
    },
    onError: (err: Error) => toast.error(err.message),
  })

  // ── Draft helpers ─────────────────────────────────────────────────
  const updateDraft = (key: string, patch: Partial<DraftItem>) =>
    onDraftChange(draft.map((d) => (d.key === key ? { ...d, ...patch } : d)))

  const changeQty = (d: DraftItem, delta: number) => {
    const next = round2(d.quantity + delta)
    if (next <= 0) onDraftChange(draft.filter((x) => x.key !== d.key))
    else updateDraft(d.key, { quantity: next })
  }

  const openEdit = (d: DraftItem) => {
    setEditing(d)
    setEditQty(String(d.quantity))
    setEditNotes(d.notes)
    setEditCourse(d.course)
  }

  const saveEdit = () => {
    if (!editing) return
    const qty = round2(parseFloat(editQty))
    if (!Number.isFinite(qty) || qty <= 0) return
    updateDraft(editing.key, { quantity: qty, notes: editNotes.trim(), course: editCourse })
    setEditing(null)
  }

  // Seed discount dialog inputs from the current order discount when opening.
  const openDiscountDialog = () => {
    const current = order?.discountAmount ?? 0
    const subtotal = order?.subtotalAmount ?? 0
    setPercentInput(current > 0 && subtotal > 0 ? String(round2((current / subtotal) * 100)) : '')
    setFixedInput(current > 0 ? String(current) : '')
    setDiscountOpen(true)
  }

  // Effective discount from the dialog inputs (clamped to [0, order subtotal]).
  const orderSubtotal = round2(order?.subtotalAmount ?? 0)
  const previewDiscount = (() => {
    if (!order) return 0
    const raw =
      discountTab === 'percent'
        ? (orderSubtotal * (parseFloat(percentInput) || 0)) / 100
        : parseFloat(fixedInput) || 0
    if (!Number.isFinite(raw) || raw < 0) return 0
    return round2(Math.min(raw, orderSubtotal))
  })()
  const previewBase = round2(orderSubtotal - previewDiscount)
  const previewTax = round2(previewBase * TAX_RATE)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{table.name}</p>
          {(order?.user?.name || userRole) && (
            <p className="text-[11px] text-muted-foreground">
              Server: {order?.user?.name ?? (userRole ? (ROLE_LABELS[userRole] ?? userRole) : '')}
            </p>
          )}
        </div>
        {order ? (
          <Badge variant="outline" className="shrink-0">
            Order #{order.id}
          </Badge>
        ) : (
          <Badge variant="secondary" className="shrink-0">
            Not sent
          </Badge>
        )}
      </div>

      {/* Body */}
      <div className="rms-scroll min-h-0 flex-1 overflow-y-auto px-4">
        {orderLoading && !order && draft.length === 0 ? (
          <div className="space-y-3 py-4">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : noItems ? (
          <div className="flex h-full min-h-[160px] flex-col items-center justify-center gap-2 py-8 text-muted-foreground">
            <ShoppingBag className="size-10 opacity-30" />
            <p className="text-sm">Tap products to add items</p>
          </div>
        ) : (
          <>
            {/* Sent to kitchen */}
            {order && order.items.length > 0 && (
              <section className="py-2">
                <div className="flex items-center justify-between">
                  <h3 className="py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Sent to kitchen ({order.items.length})
                  </h3>
                  {canCancel && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                      title="Cancel this order"
                      onClick={onCancel}
                    >
                      <Ban className="size-3.5" /> Cancel order
                    </Button>
                  )}
                </div>
                {order.items.map((item) => (
                  <SentItemRow
                    key={item.id}
                    item={item}
                    onServed={() => markServed.mutate(item.id)}
                    onRemove={() => removeItem.mutate(item.id)}
                    servedPending={markServed.isPending && markServed.variables === item.id}
                    removePending={removeItem.isPending && removeItem.variables === item.id}
                  />
                ))}
              </section>
            )}

            {/* New items (draft) */}
            {draft.length > 0 && (
              <section className="py-2">
                <h3 className="py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  New items — not sent ({draft.length})
                </h3>
                {draft.map((d) => (
                  <DraftRow
                    key={d.key}
                    item={d}
                    onQty={(delta) => changeQty(d, delta)}
                    onEdit={() => openEdit(d)}
                    onRemove={() => onDraftChange(draft.filter((x) => x.key !== d.key))}
                  />
                ))}
              </section>
            )}
          </>
        )}
      </div>

      {/* Footer */}
      <div className="shrink-0 space-y-1.5 border-t bg-muted/30 p-4">
        <SummaryRow label="Subtotal" value={formatCurrency(totals.subtotal)} />
        <div className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-1 text-muted-foreground">
            Discount
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground"
              disabled={!order}
              title={order ? 'Apply discount' : 'Send order first'}
              onClick={openDiscountDialog}
            >
              <Pencil className="size-3.5" />
            </Button>
          </span>
          <span className="tabular-nums text-muted-foreground">
            − {formatCurrency(totals.discount)}
          </span>
        </div>
        <SummaryRow label={`VAT ${Math.round(TAX_RATE * 100)}%`} value={formatCurrency(totals.tax)} />
        <div className="flex items-center justify-between border-t pt-2">
          <span className="text-sm font-semibold">Total</span>
          <span className="text-lg font-bold tabular-nums">{formatCurrency(totals.total)}</span>
        </div>
        {order && order.paidAmount > 0 && (
          <>
            <SummaryRow
              label="Paid"
              value={formatCurrency(order.paidAmount)}
              valueClassName="text-emerald-600"
            />
            <SummaryRow
              label="Remaining"
              value={formatCurrency(Math.max(0, order.remainingAmount))}
              valueClassName="font-bold text-amber-600"
            />
          </>
        )}
        <div className="flex gap-2 pt-2">
          <Button
            variant="secondary"
            className="h-11 flex-1"
            disabled={draft.length === 0 || sending}
            onClick={onSend}
          >
            {sending ? <Loader2 className="animate-spin" /> : <Send />} Send
            {draft.length > 0 && (
              <Badge className="ml-1 h-5 min-w-5 rounded-full px-1.5 tabular-nums">
                {draft.reduce((n, d) => n + d.quantity, 0)}
              </Badge>
            )}
          </Button>
          <Button className="h-11 flex-1" disabled={noItems || sending} onClick={onPay}>
            <CreditCard /> Pay
          </Button>
        </div>
      </div>

      {/* Draft item edit dialog */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{editing?.name}</DialogTitle>
            <DialogDescription>Adjust quantity, notes and course.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center justify-center gap-3">
              <Button
                variant="outline"
                size="icon"
                className="size-11"
                onClick={() => setEditQty(String(Math.max(1, round2((parseFloat(editQty) || 1) - 1))))}
              >
                <Minus />
              </Button>
              <Input
                type="number"
                min={1}
                step={1}
                value={editQty}
                onChange={(e) => setEditQty(e.target.value)}
                className="h-11 w-20 text-center text-lg font-semibold tabular-nums"
              />
              <Button
                variant="outline"
                size="icon"
                className="size-11"
                onClick={() => setEditQty(String(round2((parseFloat(editQty) || 0) + 1)))}
              >
                <Plus />
              </Button>
            </div>
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Notes</p>
              <Textarea
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                placeholder="e.g. no onions, extra spicy…"
                rows={2}
              />
            </div>
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Course</p>
              <Select value={editCourse} onValueChange={setEditCourse}>
                <SelectTrigger className="h-11 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COURSES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {COURSE_LABELS[c]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button onClick={saveEdit} disabled={!(parseFloat(editQty) > 0)}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Discount dialog */}
      <Dialog open={discountOpen} onOpenChange={setDiscountOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Apply discount</DialogTitle>
            <DialogDescription>
              Order-level discount on sent items (EGP, before VAT).
            </DialogDescription>
          </DialogHeader>
          <Tabs value={discountTab} onValueChange={(v) => setDiscountTab(v as 'percent' | 'fixed')}>
            <TabsList className="grid h-10 w-full grid-cols-2">
              <TabsTrigger value="percent">Percent</TabsTrigger>
              <TabsTrigger value="fixed">Fixed</TabsTrigger>
            </TabsList>
            <TabsContent value="percent" className="pt-3">
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={0}
                  max={100}
                  step={0.5}
                  value={percentInput}
                  onChange={(e) => setPercentInput(e.target.value)}
                  placeholder="0"
                  className="h-11 text-right text-base tabular-nums"
                />
                <span className="text-lg font-semibold text-muted-foreground">%</span>
              </div>
            </TabsContent>
            <TabsContent value="fixed" className="pt-3">
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={0}
                  step={0.5}
                  value={fixedInput}
                  onChange={(e) => setFixedInput(e.target.value)}
                  placeholder="0"
                  className="h-11 text-right text-base tabular-nums"
                />
                <span className="text-lg font-semibold text-muted-foreground">EGP</span>
              </div>
            </TabsContent>
          </Tabs>
          <div className="space-y-1.5 rounded-lg border bg-muted/40 p-3 text-sm">
            <SummaryRow label="Order subtotal" value={formatCurrency(orderSubtotal)} />
            <SummaryRow label="Discount" value={`− ${formatCurrency(previewDiscount)}`} />
            <SummaryRow label={`VAT ${Math.round(TAX_RATE * 100)}%`} value={formatCurrency(previewTax)} />
            <div className="flex items-center justify-between border-t pt-1.5 font-bold">
              <span>New total</span>
              <span className="tabular-nums">
                {formatCurrency(round2(previewBase + previewTax))}
              </span>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDiscountOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => applyDiscount.mutate(previewDiscount)}
              disabled={applyDiscount.isPending}
            >
              {applyDiscount.isPending && <Loader2 className="animate-spin" />} Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function SummaryRow({
  label,
  value,
  valueClassName,
}: {
  label: string
  value: string
  valueClassName?: string
}) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn('tabular-nums', valueClassName)}>{value}</span>
    </div>
  )
}

function SentItemRow({
  item,
  onServed,
  onRemove,
  servedPending,
  removePending,
}: {
  item: OrderItem
  onServed: () => void
  onRemove: () => void
  servedPending: boolean
  removePending: boolean
}) {
  const chip = STATUS_CHIP[item.status] ?? STATUS_CHIP.served
  const lineTotal = formatCurrency(round2(item.quantity * item.unitPrice))
  return (
    <div className="flex items-start gap-2 border-b border-border/60 py-2.5 last:border-b-0">
      <span
        className={cn(
          'mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
          chip,
        )}
      >
        {ITEM_STATUS_LABELS[item.status] ?? item.status}
      </span>
      <div className="min-w-0 flex-1" title={item.notes ?? undefined}>
        <p className="truncate text-sm font-medium">
          {formatQty(item.quantity)} × {item.product?.name ?? 'Item'}
        </p>
        {item.notes && (
          <p className="flex items-center gap-1 truncate text-xs text-amber-600">
            <StickyNote className="size-3 shrink-0" />
            <span className="truncate">{item.notes}</span>
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="text-sm font-semibold tabular-nums">{lineTotal}</span>
        <div className="flex gap-1">
          {item.status === 'ready' && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1 px-2 text-xs text-emerald-700 hover:bg-emerald-100 hover:text-emerald-800"
              disabled={servedPending}
              onClick={onServed}
              title="Mark as served"
            >
              {servedPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Check className="size-3.5" />
              )}
              Served
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-muted-foreground hover:text-destructive"
            disabled={removePending}
            onClick={onRemove}
            title="Remove item from order"
          >
            {removePending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}

function DraftRow({
  item,
  onQty,
  onEdit,
  onRemove,
}: {
  item: DraftItem
  onQty: (delta: number) => void
  onEdit: () => void
  onRemove: () => void
}) {
  return (
    <div className="flex items-center gap-2 border-b border-border/60 py-2.5 last:border-b-0">
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="outline" size="icon" className="size-8" onClick={() => onQty(-1)}>
          <Minus className="size-3.5" />
        </Button>
        <span className="w-8 text-center text-sm font-semibold tabular-nums">
          {formatQty(item.quantity)}
        </span>
        <Button variant="outline" size="icon" className="size-8" onClick={() => onQty(1)}>
          <Plus className="size-3.5" />
        </Button>
      </div>
      <button
        type="button"
        className="min-w-0 flex-1 text-left"
        onClick={onEdit}
        title="Edit notes, course & quantity"
      >
        <p className="flex items-center gap-1 truncate text-sm font-medium">
          <span className="truncate">{item.name}</span>
          {item.notes && <StickyNote className="size-3.5 shrink-0 text-amber-500" />}
        </p>
        <p className="text-[11px] text-muted-foreground">
          {COURSE_LABELS[item.course] ?? item.course}
        </p>
      </button>
      <span className="shrink-0 text-sm font-semibold tabular-nums">
        {formatCurrency(round2(item.quantity * item.price))}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
        onClick={onRemove}
        title="Remove line"
      >
        <X className="size-4" />
      </Button>
    </div>
  )
}
