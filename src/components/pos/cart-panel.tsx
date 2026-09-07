'use client'

import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeftRight,
  Ban,
  Check,
  CreditCard,
  Loader2,
  Minus,
  Pencil,
  Plus,
  Printer,
  Send,
  ShieldAlert,
  ShoppingBag,
  StickyNote,
  Trash2,
  Users,
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
import { apiFetch, fetcher } from '@/lib/api'
import { COURSES, DELETE_PIN_LENGTH, SERVICE_TAX_RATE, TAX_RATE } from '@/lib/constants'
import { formatCurrency, formatQty } from '@/lib/format'
import { useI18n, localizedName } from '@/lib/i18n'
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
  /** Open the pre-payment guest check (pos-view flushes the draft first). */
  onPrintCheck?: () => void
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
  onPrintCheck,
  onCancel,
  canCancel = false,
  sending = false,
  userRole,
}: CartPanelProps) {
  const queryClient = useQueryClient()
  const { t, lang } = useI18n()
  const orderId = order?.id ?? null

  const [editing, setEditing] = useState<DraftItem | null>(null)
  const [editQty, setEditQty] = useState('1')
  const [editNotes, setEditNotes] = useState('')
  const [editCourse, setEditCourse] = useState('main')

  const [discountOpen, setDiscountOpen] = useState(false)
  const [discountTab, setDiscountTab] = useState<'percent' | 'fixed'>('percent')
  const [percentInput, setPercentInput] = useState('')
  const [fixedInput, setFixedInput] = useState('')

  // ── PIN-gated item deletion state ─────────────────────────────────
  // Sent items may only be removed with the admin's 6-digit PIN; the
  // dialog stays open on a wrong PIN so the user can retry.
  const [pinDialogItem, setPinDialogItem] = useState<OrderItem | null>(null)
  const [pinInput, setPinInput] = useState('')
  const [pinWrong, setPinWrong] = useState(false)

  // ── Item transfer ("Move items") state ────────────────────────────
  const [moveMode, setMoveMode] = useState(false)
  const [moveSelected, setMoveSelected] = useState<Set<number>>(() => new Set())
  const [moveDialogOpen, setMoveDialogOpen] = useState(false)

  const totals = computeCartTotals(order, draft)
  const noItems = (order?.items.length ?? 0) + draft.length === 0

  // Open orders (for the move-items target picker) — only fetched while the
  // picker dialog is open; the query key matches the floor's live query.
  const { data: openOrdersData, isLoading: openOrdersLoading } = useQuery({
    queryKey: ['orders', 'open'],
    queryFn: () => fetcher<{ orders: Order[] }>('/api/orders?status=open'),
    enabled: moveDialogOpen,
  })
  const otherOpenOrders = (openOrdersData?.orders ?? []).filter((o) => o.id !== orderId)

  // ── Server mutations (sent items) ─────────────────────────────────
  const markServed = useMutation({
    mutationFn: (itemId: number) =>
      apiFetch<{ item: OrderItem }>(`/api/order-items/${itemId}`, {
        method: 'PUT',
        body: { status: 'served' },
      }),
    onSuccess: async (data) => {
      toast.success(
        t('pos.markedServedToast', {
          name: data.item.product
            ? localizedName(data.item.product.name, data.item.product.nameAr, lang)
            : t('pos.item'),
        }),
      )
      await queryClient.invalidateQueries({ queryKey: ['pos-order'] })
      await queryClient.invalidateQueries({ queryKey: ['orders'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  // Item removal is PIN-gated (PUT /api/orders/[id] { removeItemIds, removePin }):
  // the dialog collects the 6-digit PIN and the API verifies it server-side
  // (403 with a descriptive message on a wrong or missing PIN).
  const removeItem = useMutation({
    mutationFn: ({ itemId, pin }: { itemId: number; pin: string }) => {
      if (orderId == null) throw new Error(t('pos.noActiveOrder'))
      return apiFetch<{ order: Order }>(`/api/orders/${orderId}`, {
        method: 'PUT',
        body: { removeItemIds: [itemId], removePin: pin },
      })
    },
    onSuccess: async ({ order: updated }) => {
      queryClient.setQueryData(['pos-order', updated.id], { order: updated })
      await queryClient.invalidateQueries({ queryKey: ['orders'] })
      await queryClient.invalidateQueries({ queryKey: ['floorplans'] })
      await queryClient.invalidateQueries({ queryKey: ['tables-status'] })
      toast.success(t('pos.itemRemovedToast'))
      closePinDialog()
    },
    onError: (err: Error) => {
      // The API message is descriptive (403 wrong/missing PIN); the dialog
      // stays open with the inline wrong-PIN hint so the user can retry.
      toast.error(err.message)
      setPinWrong(true)
    },
  })

  // ── PIN dialog helpers ────────────────────────────────────────────
  const openPinDialog = (item: OrderItem) => {
    setPinDialogItem(item)
    setPinInput('')
    setPinWrong(false)
  }

  const closePinDialog = () => {
    setPinDialogItem(null)
    setPinInput('')
    setPinWrong(false)
  }

  const confirmPin = () => {
    if (!pinDialogItem || pinInput.length < DELETE_PIN_LENGTH || removeItem.isPending) return
    removeItem.mutate({ itemId: pinDialogItem.id, pin: pinInput })
  }

  const applyDiscount = useMutation({
    mutationFn: (discountAmount: number) => {
      if (orderId == null) throw new Error(t('pos.noActiveOrder'))
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
      toast.success(t('pos.discountUpdatedToast'))
      setDiscountOpen(false)
    },
    onError: (err: Error) => toast.error(err.message),
  })

  // ── Item transfer mutation (move sent items to another open order) ──
  const transferItems = useMutation({
    mutationFn: (vars: {
      sourceId: number
      itemIds: number[]
      targetOrderId: number
      targetLabel: string
    }) =>
      apiFetch<{ source: Order; target: Order }>(`/api/orders/${vars.sourceId}/transfer-items`, {
        method: 'POST',
        body: { itemIds: vars.itemIds, targetOrderId: vars.targetOrderId },
      }),
    onSuccess: async (_data, vars) => {
      toast.success(
        t('pos.itemsMovedToast', { n: vars.itemIds.length, target: vars.targetLabel }),
      )
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['orders'] }),
        queryClient.invalidateQueries({ queryKey: ['orders', 'open'] }),
        queryClient.invalidateQueries({ queryKey: ['floorplans'] }),
        queryClient.invalidateQueries({ queryKey: ['tables-status'] }),
        queryClient.invalidateQueries({ queryKey: ['pos-order', vars.sourceId] }),
        queryClient.invalidateQueries({ queryKey: ['pos-order', vars.targetOrderId] }),
      ])
      exitMoveMode()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  // ── Move-items helpers ───────────────────────────────────────────
  const enterMoveMode = () => {
    setMoveMode(true)
    setMoveSelected(new Set())
  }

  const exitMoveMode = () => {
    setMoveMode(false)
    setMoveSelected(new Set())
    setMoveDialogOpen(false)
  }

  const toggleMoveItem = (itemId: number) => {
    setMoveSelected((prev) => {
      const next = new Set(prev)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })
  }

  // Only ids that still exist on the (live-polled) order — stale ids are dropped.
  const selectedMoveIds = (order?.items ?? []).filter((i) => moveSelected.has(i.id)).map((i) => i.id)
  const moveCount = selectedMoveIds.length

  const pickMoveTarget = (target: Order) => {
    if (orderId == null || moveCount === 0) return
    transferItems.mutate({
      sourceId: orderId,
      itemIds: selectedMoveIds,
      targetOrderId: target.id,
      targetLabel: target.table?.name ?? t('common.takeaway'),
    })
  }

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
  const previewVat = round2(previewBase * TAX_RATE)
  const previewServiceTax = round2(previewBase * SERVICE_TAX_RATE)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[#E2E2E0] px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-base font-bold">{table.name}</p>
          {(order?.user?.name || userRole) && (
            <p className="text-[11px] text-muted-foreground">
              {t('pos.server')}:{' '}
              {order?.user?.name ?? (userRole ? t(`role.${userRole}`) : '')}
            </p>
          )}
        </div>
        {order ? (
          <Badge className="shrink-0 bg-[#714B67] text-white hover:bg-[#714B67]">
            {t('common.order')} #{order.id}
          </Badge>
        ) : (
          <Badge variant="secondary" className="shrink-0">
            {t('pos.notSent')}
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
            <p className="text-sm">{t('pos.tapToAdd')}</p>
          </div>
        ) : (
          <>
            {/* Sent to kitchen */}
            {order && order.items.length > 0 && (
              <section className="py-2">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t('pos.sentItems')} ({order.items.length})
                  </h3>
                  <div className="flex shrink-0 items-center gap-1">
                    {!moveMode && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-8 gap-1 px-2 text-xs border-[#714B67]/40 text-[#714B67] hover:bg-[#714B67]/10 hover:text-[#714B67]"
                        title={t('pos.transferItems')}
                        onClick={enterMoveMode}
                      >
                        <ArrowLeftRight className="size-3.5" /> {t('pos.transferItems')}
                      </Button>
                    )}
                    {moveMode ? (
                      <span className="text-[11px] text-muted-foreground">{t('pos.moveModeHint')}</span>
                    ) : (
                      canCancel && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 px-2 text-xs text-destructive hover:bg-destructive/10 hover:text-destructive"
                          title={t('pos.cancelOrder')}
                          onClick={onCancel}
                        >
                          <Ban className="size-3.5" /> {t('pos.cancelOrder')}
                        </Button>
                      )
                    )}
                  </div>
                </div>
                {order.items.map((item) => (
                  <SentItemRow
                    key={item.id}
                    item={item}
                    onServed={() => markServed.mutate(item.id)}
                    onRemove={() => openPinDialog(item)}
                    servedPending={markServed.isPending && markServed.variables === item.id}
                    removePending={removeItem.isPending && removeItem.variables?.itemId === item.id}
                    moveMode={moveMode}
                    moveSelected={moveSelected.has(item.id)}
                    onToggleMove={() => toggleMoveItem(item.id)}
                  />
                ))}
              </section>
            )}

            {/* New items (draft) */}
            {draft.length > 0 && (
              <section className="py-2">
                <h3 className="py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('pos.newItemsNotSent')} ({draft.length})
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
      <div className="shrink-0 space-y-1.5 border-t border-[#E2E2E0] p-4">
        <SummaryRow label={t('money.subtotal')} value={formatCurrency(totals.subtotal)} />
        <div className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-1 text-muted-foreground">
            {t('money.discount')}
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground"
              disabled={!order}
              title={order ? t('pos.applyDiscount') : t('pos.sendFirst')}
              onClick={openDiscountDialog}
            >
              <Pencil className="size-3.5" />
            </Button>
          </span>
          <span className="tabular-nums text-muted-foreground">
            − {formatCurrency(totals.discount)}
          </span>
        </div>
        <SummaryRow label={t('money.tax')} value={formatCurrency(totals.tax)} />
        <SummaryRow label={t('money.serviceTax')} value={formatCurrency(totals.serviceTax)} />
        <div className="flex items-center justify-between border-t border-[#E2E2E0] pt-2">
          <span className="text-sm font-semibold">{t('money.total')}</span>
          <span className="text-lg font-bold tabular-nums">{formatCurrency(totals.total)}</span>
        </div>
        {order && order.paidAmount > 0 && (
          <>
            <SummaryRow
              label={t('money.paid')}
              value={formatCurrency(order.paidAmount)}
              valueClassName="text-emerald-600"
            />
            <SummaryRow
              label={t('money.remaining')}
              value={formatCurrency(Math.max(0, order.remainingAmount))}
              valueClassName="font-bold text-amber-600"
            />
          </>
        )}

        {moveMode ? (
          /* ── Item-transfer footer ── */
          <div className="flex gap-2 pt-1">
            <Button
              variant="outline"
              className="h-14 flex-1 rounded-xl border-[#E2E2E0] text-sm"
              onClick={exitMoveMode}
              disabled={transferItems.isPending}
            >
              {t('common.cancel')}
            </Button>
            <Button
              className="h-14 flex-[1.6] rounded-xl bg-[#714B67] text-base font-semibold text-white hover:bg-[#714B67]/90"
              disabled={moveCount === 0 || transferItems.isPending}
              onClick={() => setMoveDialogOpen(true)}
            >
              {transferItems.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <ArrowLeftRight className="size-5" />
              )}
              <span className="truncate">{t('pos.moveNItems', { n: moveCount })}</span>
            </Button>
          </div>
        ) : (
          /* ── Normal actions ── */
          <>
            <Button
              variant="secondary"
              className="h-11 w-full rounded-xl"
              disabled={draft.length === 0 || sending}
              onClick={onSend}
            >
              {sending ? <Loader2 className="animate-spin" /> : <Send />} {t('pos.sendToKitchen')}
              {draft.length > 0 && (
                <Badge className="ms-1 h-5 min-w-5 rounded-full px-1.5 tabular-nums">
                  {draft.reduce((n, d) => n + d.quantity, 0)}
                </Badge>
              )}
            </Button>
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="h-14 flex-1 rounded-xl border-[#E2E2E0] text-sm"
                disabled={!order || sending || !onPrintCheck}
                title={!order ? t('pos.printCheckDisabled') : t('pos.printCheckHint')}
                onClick={onPrintCheck}
              >
                <Printer />
                <span className="hidden sm:inline">{t('pos.printCheck')}</span>
              </Button>
              <Button
                className="h-14 flex-[1.6] rounded-xl bg-emerald-600 text-base font-semibold text-white hover:bg-emerald-700"
                disabled={noItems || sending}
                onClick={onPay}
              >
                {sending ? <Loader2 className="animate-spin" /> : <CreditCard />}
                <span className="truncate">
                  {t('pos.payment')} · {formatCurrency(totals.total)}
                </span>
              </Button>
            </div>
          </>
        )}
      </div>

      {/* Move-items target picker dialog */}
      <Dialog open={moveDialogOpen} onOpenChange={(o) => !o && setMoveDialogOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowLeftRight className="size-5 text-[#714B67]" /> {t('pos.moveItemsTitle')}
            </DialogTitle>
            <DialogDescription>{t('pos.moveItemsDesc', { n: moveCount })}</DialogDescription>
          </DialogHeader>
          <div className="rms-scroll max-h-[50dvh] space-y-2 overflow-y-auto">
            {openOrdersLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : otherOpenOrders.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t('pos.noOtherOpenOrders')}
              </p>
            ) : (
              otherOpenOrders.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  disabled={transferItems.isPending}
                  onClick={() => pickMoveTarget(o)}
                  className="flex w-full items-center justify-between gap-3 rounded-xl border border-[#E2E2E0] bg-white p-3 text-start shadow-sm transition hover:border-[#714B67]/50 hover:bg-[#714B67]/[0.04] active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">
                      {o.table?.name ?? t('common.takeaway')}
                    </p>
                    <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                      {t('common.order')} #{o.id}
                      <span className="inline-flex items-center gap-1">
                        <Users className="size-3.5" aria-hidden /> {o.guests} {t('common.people')}
                      </span>
                    </p>
                  </div>
                  <span className="shrink-0 text-sm font-bold tabular-nums text-[#714B67]">
                    {formatCurrency(o.totalAmount)}
                  </span>
                </button>
              ))
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMoveDialogOpen(false)} disabled={transferItems.isPending}>
              {t('common.cancel')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Draft item edit dialog */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {editing ? localizedName(editing.name, editing.nameAr, lang) : ''}
            </DialogTitle>
            <DialogDescription>{t('pos.editItemDesc')}</DialogDescription>
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
              <p className="text-sm font-medium">{t('common.notes')}</p>
              <Textarea
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                placeholder={t('pos.notesPlaceholder')}
                rows={2}
              />
            </div>
            <div className="space-y-1.5">
              <p className="text-sm font-medium">{t('pos.course')}</p>
              <Select value={editCourse} onValueChange={setEditCourse}>
                <SelectTrigger className="h-11 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COURSES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {t(`course.${c}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={saveEdit} disabled={!(parseFloat(editQty) > 0)}>
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Discount dialog */}
      <Dialog open={discountOpen} onOpenChange={setDiscountOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('pos.applyDiscount')}</DialogTitle>
            <DialogDescription>{t('pos.discountDesc')}</DialogDescription>
          </DialogHeader>
          <Tabs value={discountTab} onValueChange={(v) => setDiscountTab(v as 'percent' | 'fixed')}>
            <TabsList className="grid h-10 w-full grid-cols-2">
              <TabsTrigger value="percent">{t('pos.percent')}</TabsTrigger>
              <TabsTrigger value="fixed">{t('pos.fixed')}</TabsTrigger>
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
                <span className="text-lg font-semibold text-muted-foreground">
                  {t('pos.currencySuffix')}
                </span>
              </div>
            </TabsContent>
          </Tabs>
          <div className="space-y-1.5 rounded-lg border bg-muted/40 p-3 text-sm">
            <SummaryRow label={t('money.subtotal')} value={formatCurrency(orderSubtotal)} />
            <SummaryRow label={t('money.discount')} value={`− ${formatCurrency(previewDiscount)}`} />
            <SummaryRow label={t('money.tax')} value={formatCurrency(previewVat)} />
            <SummaryRow label={t('money.serviceTax')} value={formatCurrency(previewServiceTax)} />
            <div className="flex items-center justify-between border-t pt-1.5 font-bold">
              <span>{t('pos.newTotal')}</span>
              <span className="tabular-nums">
                {formatCurrency(round2(previewBase + previewVat + previewServiceTax))}
              </span>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDiscountOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={() => applyDiscount.mutate(previewDiscount)}
              disabled={applyDiscount.isPending}
            >
              {applyDiscount.isPending && <Loader2 className="animate-spin" />} {t('common.apply')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* PIN-gated item deletion dialog — sent items only (draft rows keep
          their instant remove; they were never sent to the kitchen). */}
      <Dialog open={!!pinDialogItem} onOpenChange={(o) => !o && closePinDialog()}>
        <DialogContent className="sm:max-w-xs">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldAlert className="size-5 text-destructive" /> {t('pos.pinTitle')}
            </DialogTitle>
            <DialogDescription>
              {t('pos.pinDesc', {
                name: pinDialogItem
                  ? pinDialogItem.product
                    ? localizedName(pinDialogItem.product.name, pinDialogItem.product.nameAr, lang)
                    : t('pos.item')
                  : '',
              })}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Input
              type="password"
              inputMode="numeric"
              autoFocus
              maxLength={DELETE_PIN_LENGTH}
              value={pinInput}
              onChange={(e) => {
                // digits only — a PIN is numeric by definition
                setPinInput(e.target.value.replace(/\D/g, '').slice(0, DELETE_PIN_LENGTH))
                if (pinWrong) setPinWrong(false)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  confirmPin()
                }
              }}
              placeholder={t('pos.pinPlaceholder')}
              aria-invalid={pinWrong || undefined}
              className={cn(
                'h-11 text-center text-lg font-semibold tracking-[0.4em] tabular-nums',
                pinWrong && 'border-destructive focus-visible:border-destructive focus-visible:ring-destructive/30',
              )}
            />
            {pinWrong && (
              <p className="text-xs font-medium text-destructive" role="alert">
                {t('pos.pinWrong')}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closePinDialog} disabled={removeItem.isPending}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={confirmPin}
              disabled={removeItem.isPending || pinInput.length < DELETE_PIN_LENGTH}
            >
              {removeItem.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}{' '}
              {t('pos.pinConfirm')}
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
  moveMode,
  moveSelected,
  onToggleMove,
}: {
  item: OrderItem
  onServed: () => void
  onRemove: () => void
  servedPending: boolean
  removePending: boolean
  moveMode: boolean
  moveSelected: boolean
  onToggleMove: () => void
}) {
  const { t, lang } = useI18n()
  const chip = STATUS_CHIP[item.status] ?? STATUS_CHIP.served
  const lineTotal = formatCurrency(round2(item.quantity * item.unitPrice))
  return (
    <div
      onClick={moveMode ? onToggleMove : undefined}
      role={moveMode ? 'button' : undefined}
      aria-pressed={moveMode ? moveSelected : undefined}
      className={cn(
        'flex items-start gap-2 border-b border-border/60 py-2.5 last:border-b-0',
        moveMode && 'cursor-pointer rounded-lg transition-colors',
        moveMode && moveSelected && 'bg-[#714B67]/10',
      )}
    >
      {moveMode && (
        <span
          className={cn(
            'mt-1 flex size-5 shrink-0 items-center justify-center rounded border',
            moveSelected
              ? 'border-[#714B67] bg-[#714B67] text-white'
              : 'border-[#E2E2E0] bg-white',
          )}
          aria-hidden
        >
          {moveSelected && <Check className="size-3.5" />}
        </span>
      )}
      <span
        className={cn(
          'mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
          chip,
        )}
      >
        {t(`status.item.${item.status}`)}
      </span>
      <div className="min-w-0 flex-1" title={item.notes ?? undefined}>
        <p className="truncate text-sm font-medium">
          {formatQty(item.quantity)} ×{' '}
          {item.product
            ? localizedName(item.product.name, item.product.nameAr, lang)
            : t('pos.item')}
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
        {!moveMode && (
          <div className="flex gap-1">
            {item.status === 'ready' && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 gap-1 px-2 text-xs text-emerald-700 hover:bg-emerald-100 hover:text-emerald-800"
                disabled={servedPending}
                onClick={onServed}
                title={t('pos.markServed')}
              >
                {servedPending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Check className="size-3.5" />
                )}
                {t('status.item.served')}
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground hover:text-destructive"
              disabled={removePending}
              onClick={onRemove}
              title={t('pos.removeItem')}
            >
              {removePending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
            </Button>
          </div>
        )}
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
  const { t, lang } = useI18n()
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
        className="min-w-0 flex-1 text-start"
        onClick={onEdit}
        title={t('pos.editItemDesc')}
      >
        <p className="flex items-center gap-1 truncate text-sm font-medium">
          <span className="truncate">{localizedName(item.name, item.nameAr, lang)}</span>
          {item.notes && <StickyNote className="size-3.5 shrink-0 text-amber-500" />}
        </p>
        <p className="text-[11px] text-muted-foreground">{t(`course.${item.course}`)}</p>
      </button>
      <span className="shrink-0 text-sm font-semibold tabular-nums">
        {formatCurrency(round2(item.quantity * item.price))}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
        onClick={onRemove}
        title={t('pos.removeLine')}
      >
        <X className="size-4" />
      </Button>
    </div>
  )
}
