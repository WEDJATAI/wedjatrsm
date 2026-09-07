'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftRight, Ban, Check, ChevronLeft, Loader2, Minus, Plus, Users } from 'lucide-react'

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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { apiFetch, fetcher } from '@/lib/api'
import { MAX_GUESTS, MIN_GUESTS } from '@/lib/constants'
import { elapsedSince, formatCurrency } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import type { Order, Product, RestaurantTable, SessionUser } from '@/lib/types'
import CartPanel from './cart-panel'
import CheckModal from './check-modal'
import PaymentModal from './payment-modal'
import ReceiptModal from './receipt-modal'
import ProductGrid from './product-grid'
import TableSelect from './table-select'
import { guessCourse, newDraftKey, round2, type DraftItem } from './pos-utils'

/** Who the guests dialog edits: a fresh table draft, the unsent draft guest
 *  count, or the persisted guests value of an existing order. */
type GuestsTarget =
  | { kind: 'new-table'; table: RestaurantTable }
  | { kind: 'draft' }
  | { kind: 'order'; orderId: number }
  | null

const GUEST_QUICK_CHIPS = [1, 2, 3, 4, 5, 6, 7, 8]

export default function PosView() {
  const queryClient = useQueryClient()
  const { t } = useI18n()

  // ── State machine ────────────────────────────────────────────────
  const [mode, setMode] = useState<'tables' | 'order'>('tables')
  const [selectedTable, setSelectedTable] = useState<{ id: number | null; name: string } | null>(null)
  const [activeOrderId, setActiveOrderId] = useState<number | null>(null)
  const [draft, setDraft] = useState<DraftItem[]>([])
  const [sending, setSending] = useState(false)

  // Guest count for the order that will be created from this screen
  // (takeaway defaults to 1, table drafts to the dialog value).
  const [guestsDraft, setGuestsDraft] = useState(2)

  // Guests dialog (create-before-order-mode + edit on the order screen).
  const [guestsDialogOpen, setGuestsDialogOpen] = useState(false)
  const [guestsValue, setGuestsValue] = useState(2)
  const [guestsTarget, setGuestsTarget] = useState<GuestsTarget>(null)

  // Order being transferred (passed to TableSelect → starts at destination step).
  const [transferOrderId, setTransferOrderId] = useState<number | null>(null)

  const [payOpen, setPayOpen] = useState(false)
  const [payOrder, setPayOrder] = useState<Order | null>(null)
  const [checkOpen, setCheckOpen] = useState(false)
  const [checkOrder, setCheckOrder] = useState<Order | null>(null)
  const [receiptOrder, setReceiptOrder] = useState<Order | null>(null)
  const [cancelOpen, setCancelOpen] = useState(false)

  // 30s tick so elapsed times stay fresh.
  const [elapsedTick, setElapsedTick] = useState(0)
  useEffect(() => {
    if (mode !== 'order') return
    const timer = window.setInterval(() => setElapsedTick((x) => x + 1), 30000)
    return () => window.clearInterval(timer)
  }, [mode])

  // ── Session (for cancel permission display — server enforces anyway) ──
  const { data: sessionData } = useQuery({
    queryKey: ['session'],
    queryFn: () => fetcher<{ user: SessionUser }>('/api/auth/me'),
    retry: false,
    staleTime: 5 * 60 * 1000,
  })
  const user = sessionData?.user

  // ── Live order (poll while open) ─────────────────────────────────
  const { data: orderData, isLoading: orderLoading } = useQuery({
    queryKey: ['pos-order', activeOrderId],
    queryFn: () => fetcher<{ order: Order }>(`/api/orders/${activeOrderId}`),
    enabled: mode === 'order' && activeOrderId != null,
    refetchInterval: 5000,
  })
  const order: Order | null =
    mode === 'order' && activeOrderId != null ? (orderData?.order ?? null) : null

  // ── Products ─────────────────────────────────────────────────────
  const { data: productsData } = useQuery({
    queryKey: ['pos-products'],
    queryFn: () => fetcher<{ products: Product[] }>('/api/products?sellable=1'),
    enabled: mode === 'order',
    staleTime: 15000,
  })
  const products = productsData?.products ?? []

  // ── Newly-ready items → toast (once) ─────────────────────────────
  const readyRef = useRef<Set<number> | null>(null)
  useEffect(() => {
    if (!order) {
      readyRef.current = null
      return
    }
    const readyIds = new Set(order.items.filter((i) => i.status === 'ready').map((i) => i.id))
    const prev = readyRef.current
    if (prev) {
      const newlyReady = order.items.filter((i) => i.status === 'ready' && !prev.has(i.id))
      if (newlyReady.length > 0) {
        toast.success(
          t('pos.readyToast', {
            n: newlyReady.length,
            table: selectedTable?.name ?? t('pos.order'),
          }),
        )
      }
    }
    readyRef.current = readyIds
  }, [order, selectedTable?.name, t])

  // ── Helpers ──────────────────────────────────────────────────────
  const clampGuests = useCallback(
    (raw: number) => {
      const n = Math.round(Number.isFinite(raw) ? raw : 2)
      return Math.min(MAX_GUESTS, Math.max(MIN_GUESTS, n))
    },
    [],
  )

  const resetToTables = useCallback(() => {
    setMode('tables')
    setSelectedTable(null)
    setActiveOrderId(null)
    setDraft([])
    setGuestsDraft(2)
    setGuestsDialogOpen(false)
    setGuestsTarget(null)
    setPayOpen(false)
    setPayOrder(null)
    setCheckOpen(false)
    setCheckOrder(null)
    setCancelOpen(false)
    setTransferOrderId(null)
    readyRef.current = null
  }, [])

  const invalidateShared = useCallback(
    async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['orders'] }),
        queryClient.invalidateQueries({ queryKey: ['floorplans'] }),
        queryClient.invalidateQueries({ queryKey: ['tables-status'] }),
        queryClient.invalidateQueries({ queryKey: ['pos-products'] }),
      ])
    },
    [queryClient],
  )

  /** Enter order mode for a table (occupied → live order, free → fresh draft). */
  const applySelectTable = (table: RestaurantTable, guests: number) => {
    setSelectedTable({ id: table.id, name: table.name })
    setMode('order')
    setDraft([])
    setTransferOrderId(null)
    setGuestsDraft(clampGuests(guests))
    readyRef.current = null
    if (table.openOrderId) {
      setActiveOrderId(table.openOrderId)
    } else {
      setActiveOrderId(null)
    }
  }

  // Table clicked on the floor: occupied tables open their order directly;
  // a FREE table first asks for the number of guests (quick dialog), then
  // enters order mode with that guest count baked into the draft.
  const selectTable = (table: RestaurantTable) => {
    if (table.openOrderId != null) {
      applySelectTable(table, table.openOrderGuests ?? 2)
      return
    }
    setGuestsTarget({ kind: 'new-table', table })
    setGuestsValue(2)
    setGuestsDialogOpen(true)
  }

  const startTakeaway = () => {
    setSelectedTable({ id: null, name: t('common.takeaway') })
    setMode('order')
    setDraft([])
    setActiveOrderId(null)
    setTransferOrderId(null)
    setGuestsDraft(1) // takeaway orders default to a single guest — no dialog
    readyRef.current = null
  }

  const openTakeawayOrder = (o: Order) => {
    setSelectedTable({ id: null, name: t('common.takeaway') })
    setMode('order')
    setDraft([])
    setTransferOrderId(null)
    setGuestsDraft(o.guests ?? 1)
    readyRef.current = null
    queryClient.setQueryData(['pos-order', o.id], { order: o })
    setActiveOrderId(o.id)
  }

  // ── Guests dialog handlers ───────────────────────────────────────
  const cancelGuestsDialog = () => {
    setGuestsDialogOpen(false)
    setGuestsTarget(null)
  }

  const openGuestsEdit = () => {
    setGuestsValue(order ? order.guests : guestsDraft)
    setGuestsTarget(order ? { kind: 'order', orderId: order.id } : { kind: 'draft' })
    setGuestsDialogOpen(true)
  }

  const updateGuests = useMutation({
    mutationFn: (vars: { id: number; guests: number }) =>
      apiFetch<{ order: Order }>(`/api/orders/${vars.id}`, {
        method: 'PUT',
        body: { guests: vars.guests },
      }),
    onSuccess: async ({ order: updated }) => {
      queryClient.setQueryData(['pos-order', updated.id], { order: updated })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['floorplans'] }),
        queryClient.invalidateQueries({ queryKey: ['orders'] }),
      ])
      toast.success(t('pos.guestsUpdatedToast'))
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const confirmGuests = () => {
    const value = clampGuests(guestsValue)
    if (guestsTarget?.kind === 'new-table') {
      applySelectTable(guestsTarget.table, value)
    } else if (guestsTarget?.kind === 'draft') {
      setGuestsDraft(value)
    } else if (guestsTarget?.kind === 'order' && order) {
      updateGuests.mutate({ id: order.id, guests: value })
    }
    setGuestsDialogOpen(false)
    setGuestsTarget(null)
  }

  const addProduct = (p: Product) => {
    setDraft((prev) => {
      const course = guessCourse(p)
      const existing = prev.find((d) => d.productId === p.id && !d.notes && d.course === course)
      if (existing) {
        return prev.map((d) =>
          d.key === existing.key ? { ...d, quantity: round2(d.quantity + 1) } : d,
        )
      }
      return [
        ...prev,
        {
          key: newDraftKey(),
          productId: p.id,
          name: p.name,
          nameAr: p.nameAr ?? null,
          price: p.price,
          quantity: 1,
          notes: '',
          course,
        },
      ]
    })
  }

  const draftToPayload = (d: DraftItem[]) =>
    d.map((d) => ({
      productId: d.productId,
      quantity: d.quantity,
      notes: d.notes.trim() || undefined,
      course: d.course,
    }))

  const sendToKitchen = async (): Promise<Order | null> => {
    if (draft.length === 0 || sending) return order
    setSending(true)
    try {
      let result: { order: Order }
      if (!order) {
        result = await apiFetch<{ order: Order }>('/api/orders', {
          method: 'POST',
          body: {
            tableId: selectedTable?.id ?? null,
            items: draftToPayload(draft),
            guests: clampGuests(guestsDraft),
          },
        })
      } else {
        result = await apiFetch<{ order: Order }>(`/api/orders/${order.id}`, {
          method: 'PUT',
          body: { addItems: draftToPayload(draft) },
        })
      }
      setDraft([])
      queryClient.setQueryData(['pos-order', result.order.id], { order: result.order })
      setActiveOrderId(result.order.id)
      await invalidateShared()
      toast.success(t('pos.orderSentToast'))
      return result.order
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('pos.sendFailedToast'))
      return null
    } finally {
      setSending(false)
    }
  }

  const handlePay = async () => {
    if (sending) return
    let current: Order | null = order
    if (draft.length > 0) {
      current = await sendToKitchen()
      if (!current) return // sending failed → abort payment
    }
    if (!current) return
    setPayOrder(current)
    setPayOpen(true)
  }

  // Print Check from the cart panel: flush the draft first (same pattern as pay),
  // then open the check modal with the fresh order state.
  const handlePrintCheck = async () => {
    if (sending) return
    let current: Order | null = order
    if (draft.length > 0) {
      current = await sendToKitchen()
      if (!current) return // sending failed → abort printing
    }
    if (!current) return
    setCheckOrder(current)
    setCheckOpen(true)
  }

  const handlePaySuccess = async (updated: Order, closed: boolean) => {
    if (closed) {
      // Payment modal closes itself; show the receipt, then reset the screen.
      setReceiptOrder(updated)
      setMode('tables')
      setSelectedTable(null)
      setActiveOrderId(null)
      setDraft([])
      setGuestsDraft(2)
      readyRef.current = null
      await invalidateShared()
    } else {
      queryClient.setQueryData(['pos-order', updated.id], { order: updated })
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['orders'] }),
        queryClient.invalidateQueries({ queryKey: ['floorplans'] }),
      ])
    }
  }

  // Transfer clicked on the order screen → go to the floor screen with the
  // order preselected (destination step). TableSelect reports completion.
  const startTransfer = () => {
    if (!order) return
    setTransferOrderId(order.id)
    setMode('tables')
    setSelectedTable(null)
    setActiveOrderId(null)
    setDraft([])
    setGuestsDraft(2)
    readyRef.current = null
  }

  const handleTransferDone = () => {
    setTransferOrderId(null)
    resetToTables()
  }

  const cancelMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ order: Order }>(`/api/orders/${id}/cancel`, { method: 'POST' }),
    onSuccess: async () => {
      toast.success(t('pos.cancelToast'))
      await invalidateShared()
      resetToTables()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const canCancel =
    !!order && !!user && (user.role === 'admin' || (order.userId != null && order.userId === user.id))

  const preparingCount = order?.items.filter((i) => i.status === 'preparing').length ?? 0
  const readyCount = order?.items.filter((i) => i.status === 'ready').length ?? 0

  // ── Render ───────────────────────────────────────────────────────
  if (mode === 'tables') {
    return (
      <>
        <TableSelect
          onSelectTable={selectTable}
          onTakeaway={startTakeaway}
          onOpenTakeawayOrder={openTakeawayOrder}
          transferOrderId={transferOrderId}
          onTransferDone={handleTransferDone}
        />
        {/* Guests quick dialog — shown BEFORE entering order mode on a free table. */}
        <GuestsDialog
          open={guestsDialogOpen}
          value={guestsValue}
          pending={updateGuests.isPending}
          onValueChange={setGuestsValue}
          onConfirm={confirmGuests}
          onCancel={cancelGuestsDialog}
        />
        {/* Receipt after a full payment — the screen resets to the floor while
            the receipt stays on top (independent of the payment modal). */}
        {receiptOrder && (
          <ReceiptModal
            order={receiptOrder}
            open={!!receiptOrder}
            onOpenChange={(o) => {
              if (!o) setReceiptOrder(null)
            }}
            onClose={() => setReceiptOrder(null)}
          />
        )}
      </>
    )
  }

  return (
    <div className="flex h-full min-h-[560px] flex-col">
      {/* ── Top bar (Odoo order chrome) ── */}
      <header className="flex min-h-16 shrink-0 flex-wrap items-center gap-2 border-b border-[#E2E2E0] bg-white px-3 py-2 shadow-sm sm:px-4">
        <Button
          variant="ghost"
          className="h-11 rounded-xl px-3 text-[#714B67] hover:bg-[#714B67]/10"
          onClick={resetToTables}
          title={t('pos.backToTables')}
        >
          <ChevronLeft className="size-5 rtl:rotate-180" />
          <span>{t('pos.title')}</span>
        </Button>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-xl font-bold">{selectedTable?.name ?? t('pos.order')}</span>
          {order && (
            <Badge className="bg-[#714B67] text-white hover:bg-[#714B67]">
              {t('common.order')} #{order.id}
            </Badge>
          )}
          {order && (
            <span className="text-xs tabular-nums text-muted-foreground" data-tick={elapsedTick}>
              {elapsedSince(order.createdAt)}
            </span>
          )}
          {preparingCount > 0 && (
            <Badge className="border-amber-300 bg-amber-100 text-amber-800 hover:bg-amber-100">
              {t('pos.preparingCount', { n: preparingCount })}
            </Badge>
          )}
          {readyCount > 0 && (
            <Badge className="border-emerald-300 bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
              {t('pos.readyCount', { n: readyCount })}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {/* Guests: N — edit while drafting (sent with the order) or on the live order */}
          <Button
            variant="outline"
            className="h-11 rounded-xl border-[#714B67]/40 text-[#714B67] hover:bg-[#714B67]/10 hover:text-[#714B67]"
            onClick={openGuestsEdit}
            title={t('pos.editGuests')}
          >
            <Users />
            <span className="hidden sm:inline">{t('common.guests')}:</span>
            <span className="font-semibold tabular-nums">{order ? order.guests : guestsDraft}</span>
          </Button>
          <Button
            variant="outline"
            className="h-11 rounded-xl border-[#714B67]/40 text-[#714B67] hover:bg-[#714B67]/10 hover:text-[#714B67]"
            disabled={!order}
            onClick={startTransfer}
            title={order ? t('pos.transferHint') : t('pos.transferDisabledHint')}
          >
            <ArrowLeftRight />
            <span className="hidden md:inline">{t('pos.transfer')}</span>
          </Button>
          {order && canCancel && (
            <Button
              variant="outline"
              className="h-11 rounded-xl border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setCancelOpen(true)}
            >
              <Ban />
              <span className="hidden md:inline">{t('common.cancel')}</span>
            </Button>
          )}
        </div>
      </header>

      {/* ── Body: product grid + cart ── */}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <ProductGrid products={products} onAdd={addProduct} className="min-h-0 flex-1" />
        <div className="flex max-h-[60vh] w-full shrink-0 flex-col border-t border-[#E2E2E0] bg-white md:max-h-none md:w-[380px] md:border-l md:border-t-0 lg:w-[420px]">
          <CartPanel
            order={order}
            orderLoading={orderLoading}
            draft={draft}
            table={selectedTable ?? { id: null, name: t('pos.order') }}
            onDraftChange={setDraft}
            onSend={() => void sendToKitchen()}
            onPay={() => void handlePay()}
            onPrintCheck={() => void handlePrintCheck()}
            onCancel={() => setCancelOpen(true)}
            canCancel={canCancel}
            sending={sending}
            userRole={user?.role ?? ''}
          />
        </div>
      </div>

      {/* ── Guests edit dialog (order mode) ── */}
      <GuestsDialog
        open={guestsDialogOpen}
        value={guestsValue}
        pending={updateGuests.isPending}
        onValueChange={setGuestsValue}
        onConfirm={confirmGuests}
        onCancel={cancelGuestsDialog}
      />

      {/* ── Cancel order confirmation ── */}
      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('pos.cancelTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('pos.cancelDesc', {
                order: order?.id ?? 0,
                table: selectedTable?.name ?? t('pos.order'),
                total: formatCurrency(order?.totalAmount ?? 0),
                items: order?.items.length ?? 0,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelMutation.isPending}>
              {t('pos.keepOrder')}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={cancelMutation.isPending}
              onClick={(e) => {
                e.preventDefault()
                if (order) cancelMutation.mutate(order.id)
              }}
            >
              {cancelMutation.isPending && <Loader2 className="animate-spin" />}{' '}
              {t('pos.cancelOrder')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Split payment ── */}
      {payOrder && (
        <PaymentModal
          order={payOrder}
          open={payOpen}
          onOpenChange={(o) => {
            setPayOpen(o)
            if (!o) setPayOrder(null)
          }}
          onSuccess={(updated, closed) => void handlePaySuccess(updated, closed)}
        />
      )}

      {/* ── Pre-payment guest check (from the cart panel) ── */}
      {checkOrder && (
        <CheckModal
          key={checkOrder.id}
          order={checkOrder}
          open={checkOpen}
          onOpenChange={(o) => {
            setCheckOpen(o)
            if (!o) setCheckOrder(null)
          }}
        />
      )}

      {/* ── Receipt — shown after an order is fully paid, independent of the payment modal ── */}
      {receiptOrder && (
        <ReceiptModal
          order={receiptOrder}
          open={!!receiptOrder}
          onOpenChange={(o) => {
            if (!o) setReceiptOrder(null)
          }}
          onClose={() => setReceiptOrder(null)}
        />
      )}
    </div>
  )
}

/** Quick guests picker — stepper + 1-8 chips (min MIN_GUESTS, max MAX_GUESTS). */
function GuestsDialog({
  open,
  value,
  pending,
  onValueChange,
  onConfirm,
  onCancel,
}: {
  open: boolean
  value: number
  pending: boolean
  onValueChange: (v: number) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  const { t } = useI18n()

  const step = (delta: number) => {
    const next = Math.min(MAX_GUESTS, Math.max(MIN_GUESTS, Math.round(value + delta)))
    onValueChange(next)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="size-5 text-[#714B67]" /> {t('pos.editGuests')}
          </DialogTitle>
          <DialogDescription>{t('pos.guestsDialogDesc')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-center justify-center gap-4">
            <Button
              variant="outline"
              size="icon"
              className="size-12 rounded-xl"
              disabled={value <= MIN_GUESTS}
              onClick={() => step(-1)}
              aria-label={t('pos.fewerGuests')}
            >
              <Minus />
            </Button>
            <span className="w-16 text-center text-4xl font-bold tabular-nums">{value}</span>
            <Button
              variant="outline"
              size="icon"
              className="size-12 rounded-xl"
              disabled={value >= MAX_GUESTS}
              onClick={() => step(1)}
              aria-label={t('pos.moreGuests')}
            >
              <Plus />
            </Button>
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {GUEST_QUICK_CHIPS.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => onValueChange(n)}
                className={cn(
                  'h-11 rounded-full border text-sm font-semibold tabular-nums transition-colors',
                  value === n
                    ? 'border-[#714B67] bg-[#714B67] text-white'
                    : 'border-[#E2E2E0] bg-white text-stone-600 hover:border-[#714B67]/40',
                )}
              >
                {n}
              </button>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            {t('common.cancel')}
          </Button>
          <Button
            className="bg-[#714B67] text-white hover:bg-[#714B67]/90"
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? <Loader2 className="animate-spin" /> : <Check />} {t('common.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
