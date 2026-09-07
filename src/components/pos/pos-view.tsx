'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Ban, CreditCard, Loader2, Send } from 'lucide-react'

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
import { apiFetch, fetcher } from '@/lib/api'
import { elapsedSince, formatCurrency } from '@/lib/format'
import { toast } from 'sonner'
import type { Order, Product, RestaurantTable, SessionUser } from '@/lib/types'
import CartPanel from './cart-panel'
import PaymentModal from './payment-modal'
import ReceiptModal from './receipt-modal'
import ProductGrid from './product-grid'
import TableSelect from './table-select'
import { guessCourse, newDraftKey, round2, type DraftItem } from './pos-utils'

export default function PosView() {
  const queryClient = useQueryClient()

  // ── State machine ────────────────────────────────────────────────
  const [mode, setMode] = useState<'tables' | 'order'>('tables')
  const [selectedTable, setSelectedTable] = useState<{ id: number | null; name: string } | null>(null)
  const [activeOrderId, setActiveOrderId] = useState<number | null>(null)
  const [draft, setDraft] = useState<DraftItem[]>([])
  const [sending, setSending] = useState(false)

  const [payOpen, setPayOpen] = useState(false)
  const [payOrder, setPayOrder] = useState<Order | null>(null)
  const [receiptOrder, setReceiptOrder] = useState<Order | null>(null)
  const [cancelOpen, setCancelOpen] = useState(false)

  // 30s tick so elapsed times stay fresh.
  const [elapsedTick, setElapsedTick] = useState(0)
  useEffect(() => {
    if (mode !== 'order') return
    const t = window.setInterval(() => setElapsedTick((x) => x + 1), 30000)
    return () => window.clearInterval(t)
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
        toast.success(`🔔 ${newlyReady.length} item(s) ready — ${selectedTable?.name ?? 'Order'}`)
      }
    }
    readyRef.current = readyIds
  }, [order, selectedTable?.name])

  // ── Helpers ──────────────────────────────────────────────────────
  const resetToTables = useCallback(() => {
    setMode('tables')
    setSelectedTable(null)
    setActiveOrderId(null)
    setDraft([])
    setPayOpen(false)
    setPayOrder(null)
    setCancelOpen(false)
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

  const selectTable = (table: RestaurantTable) => {
    setSelectedTable({ id: table.id, name: table.name })
    setMode('order')
    setDraft([])
    readyRef.current = null
    if (table.openOrderId) {
      setActiveOrderId(table.openOrderId)
    } else {
      setActiveOrderId(null)
    }
  }

  const startTakeaway = () => {
    setSelectedTable({ id: null, name: 'Takeaway' })
    setMode('order')
    setDraft([])
    setActiveOrderId(null)
    readyRef.current = null
  }

  const openTakeawayOrder = (o: Order) => {
    setSelectedTable({ id: null, name: 'Takeaway' })
    setMode('order')
    setDraft([])
    readyRef.current = null
    queryClient.setQueryData(['pos-order', o.id], { order: o })
    setActiveOrderId(o.id)
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
          body: { tableId: selectedTable?.id ?? null, items: draftToPayload(draft) },
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
      toast.success('Order sent to kitchen')
      return result.order
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to send order')
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

  const handlePaySuccess = async (updated: Order, closed: boolean) => {
    if (closed) {
      // Payment modal closes itself; show the receipt, then reset the screen.
      setReceiptOrder(updated)
      setMode('tables')
      setSelectedTable(null)
      setActiveOrderId(null)
      setDraft([])
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

  const cancelMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ order: Order }>(`/api/orders/${id}/cancel`, { method: 'POST' }),
    onSuccess: async () => {
      toast.success('Order cancelled')
      await invalidateShared()
      resetToTables()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const canCancel =
    !!order && !!user && (user.role === 'admin' || (order.userId != null && order.userId === user.id))

  const itemCount = (order?.items.length ?? 0) + draft.length
  const preparingCount = order?.items.filter((i) => i.status === 'preparing').length ?? 0
  const readyCount = order?.items.filter((i) => i.status === 'ready').length ?? 0
  const draftQty = draft.reduce((n, d) => n + d.quantity, 0)

  // ── Render ───────────────────────────────────────────────────────
  if (mode === 'tables') {
    return <TableSelect onSelectTable={selectTable} onTakeaway={startTakeaway} onOpenTakeawayOrder={openTakeawayOrder} />
  }

  return (
    <div className="flex h-full min-h-[560px] flex-col">
      {/* Top bar */}
      <header className="flex min-h-16 shrink-0 flex-wrap items-center gap-2 border-b bg-card px-3 py-2 sm:px-4">
        <Button variant="ghost" className="h-11 px-3" onClick={resetToTables} title="Back to tables">
          <ArrowLeft />
          <span className="hidden sm:inline">Tables</span>
        </Button>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-lg font-bold">{selectedTable?.name ?? 'Order'}</span>
          {order && <Badge variant="outline">Order #{order.id}</Badge>}
          {order && (
            <span className="text-xs tabular-nums text-muted-foreground" data-tick={elapsedTick}>
              {elapsedSince(order.createdAt)}
            </span>
          )}
          {preparingCount > 0 && (
            <Badge className="border-amber-300 bg-amber-100 text-amber-800 hover:bg-amber-100">
              {preparingCount} preparing
            </Badge>
          )}
          {readyCount > 0 && (
            <Badge className="border-emerald-300 bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
              {readyCount} ready
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {order && canCancel && (
            <Button
              variant="outline"
              className="h-11 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setCancelOpen(true)}
            >
              <Ban />
              <span className="hidden md:inline">Cancel</span>
            </Button>
          )}
          <Button
            variant="secondary"
            className="h-11"
            disabled={draft.length === 0 || sending}
            onClick={() => void sendToKitchen()}
          >
            {sending ? <Loader2 className="animate-spin" /> : <Send />}
            <span className="hidden md:inline">Send to Kitchen</span>
            {draft.length > 0 && (
              <Badge className="h-5 min-w-5 rounded-full px-1.5 tabular-nums">{draftQty}</Badge>
            )}
          </Button>
          <Button className="h-11" disabled={itemCount === 0 || sending} onClick={() => void handlePay()}>
            <CreditCard />
            <span className="hidden md:inline">Pay</span>
          </Button>
        </div>
      </header>

      {/* Body: product grid + cart */}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <ProductGrid products={products} onAdd={addProduct} className="min-h-0 flex-1" />
        <div className="flex max-h-[60vh] w-full shrink-0 flex-col border-t bg-card md:max-h-none md:w-[380px] md:border-l md:border-t-0 lg:w-[420px]">
          <CartPanel
            order={order}
            orderLoading={orderLoading}
            draft={draft}
            table={selectedTable ?? { id: null, name: 'Order' }}
            onDraftChange={setDraft}
            onSend={() => void sendToKitchen()}
            onPay={() => void handlePay()}
            onCancel={() => setCancelOpen(true)}
            canCancel={canCancel}
            sending={sending}
            userRole={user?.role ?? ''}
          />
        </div>
      </div>

      {/* Cancel order confirmation */}
      <AlertDialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel this order?</AlertDialogTitle>
            <AlertDialogDescription>
              Order #{order?.id} on {selectedTable?.name} — {formatCurrency(order?.totalAmount ?? 0)}{' '}
              with {order?.items.length ?? 0} item(s). The table will be freed and no inventory will
              be deducted. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelMutation.isPending}>Keep order</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={cancelMutation.isPending}
              onClick={(e) => {
                e.preventDefault()
                if (order) cancelMutation.mutate(order.id)
              }}
            >
              {cancelMutation.isPending && <Loader2 className="animate-spin" />} Cancel order
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Split payment */}
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

      {/* Receipt — shown after an order is fully paid, independent of the payment modal */}
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
