'use client'

// ─── R15: Waiter Portal — the mobile POS surface ────────────────────
// Owner: 15-c. A phone-first POS for waiters (and any pos-permitted
// user on a phone): floor with live table status, a full-screen order
// builder (products + modifiers + cart sheet + send-to-kitchen) and a
// "My Orders" list with bill / pay / cancel actions. The flows mirror
// src/components/pos/pos-view.tsx exactly — same API payloads (POST
// /api/orders with { tableId, guests, orderType, items }, PUT
// /api/orders/{id} with { addItems }), same offline queue path, same
// seating semantics (a free table asks for guests first; the order is
// created when the first items are sent, not at seat time).
//
// The portal keeps its own state and is kept mounted (hidden) by the
// mobile shell while other views are open — unsent drafts survive view
// switches, exactly like the desktop PosView.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Armchair,
  WifiOff,
  BadgeCheck,
  Ban,
  Bike,
  Brush,
  Check,
  ClipboardList,
  Clock,
  Hourglass,
  Loader2,
  Minus,
  Plus,
  ReceiptText,
  RefreshCw,
  Send,
  ShoppingBag,
  Users,
  Utensils,
  Wallet,
} from 'lucide-react'
import { toast } from 'sonner'

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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'

import CheckModal from '@/components/pos/check-modal'
import ModifierSheet, { type ModifierSheetSelection } from '@/components/pos/modifier-sheet'
import PaymentModal from '@/components/pos/payment-modal'
import ReceiptModal from '@/components/pos/receipt-modal'
import {
  computeCartTotals,
  guessCourse,
  lineUnitPrice,
  modifierSignature,
  newDraftKey,
  round2,
  type DraftItem,
} from '@/components/pos/pos-utils'

import { apiFetch, fetcher } from '@/lib/api'
import { MAX_GUESTS, MIN_GUESTS } from '@/lib/constants'
import { elapsedSince, formatCurrency, formatQty } from '@/lib/format'
import { localizedName, useI18n } from '@/lib/i18n'
import { enqueueOfflineAction } from '@/lib/offline-queue'
import { cn } from '@/lib/utils'
import type { FloorPlan, Order, Product, RestaurantTable, SessionUser } from '@/lib/types'

/** Which bottom-tab the shell is showing inside the portal. */
export type WaiterPortalTab = 'tables' | 'orders'

type OrderKind = 'dinein' | 'takeaway' | 'delivery'

const GUEST_QUICK_CHIPS = [1, 2, 3, 4, 5, 6, 7, 8]

/** R13 PWA: read the mirrored product catalog (undefined when never cached). */
function readProductsCache(): { products: Product[] } | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    const raw = window.localStorage.getItem('rms-pos-products-cache')
    if (!raw) return undefined
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { products?: unknown }).products)) {
      return parsed as { products: Product[] }
    }
  } catch {
    // corrupt cache — treat as absent
  }
  return undefined
}

/** Odoo duration "heat" for occupied tiles — mirrors table-select's TableTile. */
function occupancyHeat(mins: number) {
  if (mins < 15)
    return { tile: 'border-emerald-200 bg-emerald-50', text: 'text-emerald-900', amount: 'text-emerald-700', meta: 'text-emerald-600' }
  if (mins < 45) return { tile: 'border-amber-200 bg-amber-50', text: 'text-amber-900', amount: 'text-amber-700', meta: 'text-amber-600' }
  if (mins < 90) return { tile: 'border-orange-300 bg-orange-100', text: 'text-orange-900', amount: 'text-orange-700', meta: 'text-orange-600' }
  return { tile: 'border-rose-300 bg-rose-100', text: 'text-rose-900', amount: 'text-rose-700', meta: 'text-rose-600' }
}

/** Status chip colors for sent lines — mirrors cart-panel's STATUS_CHIP. */
const STATUS_CHIP: Record<string, string> = {
  new: 'bg-zinc-100 text-zinc-500',
  preparing: 'bg-amber-100 text-amber-700 animate-pulse',
  ready: 'bg-emerald-100 text-emerald-700',
  served: 'bg-muted text-muted-foreground',
}

export default function WaiterPortal({
  user,
  active,
  tab,
  onSwitchTab,
}: {
  user: SessionUser
  /** true while the pos view is the visible top-level view */
  active: boolean
  /** which portal tab the shell shows (Tables / My Orders) */
  tab: WaiterPortalTab
  /** ask the shell to flip to the Tables tab (My Orders → Add items) */
  onSwitchTab: (tab: WaiterPortalTab) => void
}) {
  const queryClient = useQueryClient()
  const { t } = useI18n()

  // ── State machine (mirrors pos-view, minus transfer/merge tools) ──
  const [mode, setMode] = useState<'floor' | 'builder'>('floor')
  const [selectedTable, setSelectedTable] = useState<{ id: number | null; name: string } | null>(null)
  const [activeOrderId, setActiveOrderId] = useState<number | null>(null)
  const [draft, setDraft] = useState<DraftItem[]>([])
  const [sending, setSending] = useState(false)
  const [guestsDraft, setGuestsDraft] = useState(2)

  // Guests dialog (free-table seating / draft edit / live-order edit)
  const [guestsDialogOpen, setGuestsDialogOpen] = useState(false)
  const [guestsValue, setGuestsValue] = useState(2)
  const [guestsTarget, setGuestsTarget] = useState<
    { kind: 'new-table'; table: RestaurantTable } | { kind: 'draft' } | { kind: 'order'; orderId: number } | null
  >(null)

  // Delivery dialog (phone required + optional address) — mirrors table-select
  const [deliveryOpen, setDeliveryOpen] = useState(false)
  const [deliveryPhone, setDeliveryPhone] = useState('')
  const [deliveryAddress, setDeliveryAddress] = useState('')

  // Multi-order picker (several open orders claim one table)
  const [pickerOrders, setPickerOrders] = useState<Order[] | null>(null)

  // Paid/deferred/dirty turnover (tap → bus / clean confirm)
  const [clearTarget, setClearTarget] = useState<RestaurantTable | null>(null)

  // Order-type context — dinein (table-bound) / takeaway / delivery
  const orderKindRef = useRef<OrderKind>('dinein')
  const [deliveryInfo, setDeliveryInfo] = useState<{ phone: string; address: string } | null>(null)

  // Product tapped on the grid that has option groups → modifier sheet
  const [sheetProduct, setSheetProduct] = useState<Product | null>(null)

  // Cart sheet (bottom)
  const [cartOpen, setCartOpen] = useState(false)

  // Bill / pay / receipt / cancel targets (builder + my orders)
  const [payOrder, setPayOrder] = useState<Order | null>(null)
  const [checkOrder, setCheckOrder] = useState<Order | null>(null)
  const [receiptOrder, setReceiptOrder] = useState<Order | null>(null)
  const [cancelTarget, setCancelTarget] = useState<Order | null>(null)

  // Unsent drafts stashed per context (table:N / takeaway / delivery)
  const draftStashRef = useRef<Map<string, DraftItem[]>>(new Map())

  // 30s tick so elapsed times stay fresh while the portal is visible
  const [elapsedTick, setElapsedTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => setElapsedTick((x) => x + 1), 30000)
    return () => window.clearInterval(timer)
  }, [active])

  const clampGuests = useCallback((raw: number) => {
    const n = Math.round(Number.isFinite(raw) ? raw : 2)
    return Math.min(MAX_GUESTS, Math.max(MIN_GUESTS, n))
  }, [])

  // ── Queries ──────────────────────────────────────────────────────
  const {
    data: floorPlanData,
    isLoading: floorLoading,
    isError: floorError,
    refetch: refetchFloor,
  } = useQuery({
    queryKey: ['floorplans'],
    queryFn: () => fetcher<{ floorPlans: FloorPlan[] }>('/api/floorplans'),
    refetchInterval: 3000, // LIVE table statuses (same as the desktop floor)
    enabled: active && mode === 'floor',
  })

  const {
    data: openOrdersData,
    isError: openOrdersError,
    refetch: refetchOpenOrders,
  } = useQuery({
    queryKey: ['orders', 'open'],
    queryFn: () => fetcher<{ orders: Order[] }>('/api/orders?status=open'),
    refetchInterval: 30000,
    enabled: active,
  })
  const openOrders = openOrdersData?.orders ?? []

  const { data: orderData, isLoading: orderLoading } = useQuery({
    queryKey: ['pos-order', activeOrderId],
    queryFn: () => fetcher<{ order: Order }>(`/api/orders/${activeOrderId}`),
    enabled: mode === 'builder' && activeOrderId != null,
    refetchInterval: 5000,
  })
  const order: Order | null = mode === 'builder' && activeOrderId != null ? (orderData?.order ?? null) : null

  // R13 PWA: sellable catalog mirrored to localStorage (offline fallback)
  const productsQuery = useQuery({
    queryKey: ['pos-products'],
    queryFn: async () => {
      const fetched = await fetcher<{ products: Product[] }>('/api/products?sellable=1')
      try {
        window.localStorage.setItem('rms-pos-products-cache', JSON.stringify(fetched))
      } catch {
        // storage unavailable — cache skip is non-fatal
      }
      return fetched
    },
    enabled: mode === 'builder',
    staleTime: 15000,
    placeholderData: readProductsCache(),
  })
  const products = productsQuery.data?.products ?? []

  // ── Draft stash helpers (same scheme as pos-view) ────────────────
  const draftStashKey = (table: { id: number | null } | null) =>
    table?.id != null ? `table:${table.id}` : orderKindRef.current === 'delivery' ? 'delivery' : 'takeaway'

  const stashDraft = () => {
    if (draft.length > 0) draftStashRef.current.set(draftStashKey(selectedTable), draft)
  }

  const restoreStash = (key: string, label: string) => {
    const stashed = draftStashRef.current.get(key)
    draftStashRef.current.delete(key)
    if (stashed?.length) {
      setDraft(stashed)
      toast.success(t('pos.draftRestoredToast', { table: label }))
    }
  }

  const invalidateShared = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['orders'] }),
      queryClient.invalidateQueries({ queryKey: ['orders', 'deferred'] }),
      queryClient.invalidateQueries({ queryKey: ['floorplans'] }),
      queryClient.invalidateQueries({ queryKey: ['tables-status'] }),
      queryClient.invalidateQueries({ queryKey: ['pos-products'] }),
    ])
  }, [queryClient])

  // ── Entry helpers ────────────────────────────────────────────────
  /** Enter the builder for a table draft (order is created on first send). */
  const enterTableDraft = (table: RestaurantTable, guests: number) => {
    setSelectedTable({ id: table.id, name: table.name })
    setMode('builder')
    setDraft([])
    setActiveOrderId(null)
    setGuestsDraft(clampGuests(guests))
    orderKindRef.current = 'dinein'
    setDeliveryInfo(null)
    setCartOpen(false)
  }

  /** Enter the builder for a LIVE order (occupied table / my orders). */
  const openOrder = (o: Order) => {
    const isDelivery = o.tableId == null && o.orderType === 'delivery'
    setSelectedTable(
      o.table
        ? { id: o.table.id, name: o.table.name }
        : isDelivery
          ? { id: null, name: `${t('m.newDelivery')} · ${o.deliveryPhone ?? ''}` }
          : { id: null, name: t('common.takeaway') },
    )
    setMode('builder')
    setDraft([])
    setActiveOrderId(o.id)
    setGuestsDraft(clampGuests(o.guests ?? 1))
    orderKindRef.current = o.table ? 'dinein' : isDelivery ? 'delivery' : 'takeaway'
    setDeliveryInfo(
      isDelivery ? { phone: o.deliveryPhone ?? '', address: o.deliveryAddress ?? '' } : null,
    )
    setCartOpen(false)
    queryClient.setQueryData(['pos-order', o.id], { order: o })
    restoreStash(o.table ? `table:${o.table.id}` : orderKindRef.current, o.table?.name ?? t('common.takeaway'))
  }

  const startTakeaway = () => {
    setSelectedTable({ id: null, name: t('common.takeaway') })
    setMode('builder')
    setDraft([])
    setActiveOrderId(null)
    setGuestsDraft(1) // takeaway orders default to a single guest — no dialog
    orderKindRef.current = 'takeaway'
    setDeliveryInfo(null)
    setCartOpen(false)
    restoreStash('takeaway', t('common.takeaway'))
  }

  const startDelivery = (phone: string, address: string) => {
    setSelectedTable({ id: null, name: `${t('m.newDelivery')} · ${phone}` })
    setMode('builder')
    setDraft([])
    setActiveOrderId(null)
    setGuestsDraft(1) // one delivery customer — no guests dialog
    orderKindRef.current = 'delivery'
    setDeliveryInfo({ phone, address })
    setCartOpen(false)
    restoreStash('delivery', t('m.newDelivery'))
  }

  /** Leave the builder for the floor (stash any unsent draft). */
  const backToFloor = () => {
    stashDraft()
    setMode('floor')
    setSelectedTable(null)
    setActiveOrderId(null)
    setDraft([])
    setGuestsDraft(2)
    setCartOpen(false)
    setSheetProduct(null)
  }

  // ── Floor interactions ───────────────────────────────────────────
  const isCleanupState = (tb: RestaurantTable) =>
    (tb.status === 'paid' || tb.status === 'deferred' || tb.status === 'dirty') && tb.openOrderId == null

  const selectTable = (tb: RestaurantTable) => {
    if (isCleanupState(tb)) {
      setClearTarget(tb)
      return
    }
    if (tb.openOrderId == null) {
      // FREE table → guests quick dialog, then a seated draft (the order is
      // created on first send — same semantics as the desktop POS).
      setGuestsTarget({ kind: 'new-table', table: tb })
      setGuestsValue(2)
      setGuestsDialogOpen(true)
      return
    }
    // OCCUPIED — open orders bound to this table (primary match first,
    // extra/merged tables after), with the floor's openOrderId as fallback
    // when the list query is momentarily stale.
    const matches = openOrders
      .filter((o) => o.status === 'open' && (o.tableId === tb.id || (o.extraTableIds ?? []).includes(tb.id)))
      .slice()
      .sort((a, b) => (a.tableId === tb.id ? 0 : 1) - (b.tableId === tb.id ? 0 : 1))
    if (matches.length > 1) {
      setPickerOrders(matches)
      return
    }
    if (matches.length === 1) {
      openOrder(matches[0])
      return
    }
    void (async () => {
      try {
        const data = await fetcher<{ order: Order }>(`/api/orders/${tb.openOrderId}`)
        if (data.order.status === 'open') openOrder(data.order)
        else toast.error(t('pos.cannotReopenToast'))
      } catch {
        toast.error(t('pos.cannotReopenToast'))
      }
    })()
  }

  const confirmDelivery = () => {
    const phone = deliveryPhone.trim()
    if (phone.length < 5 || phone.length > 20) return
    const address = deliveryAddress.trim().slice(0, 200)
    setDeliveryOpen(false)
    setDeliveryPhone('')
    setDeliveryAddress('')
    startDelivery(phone, address)
  }

  // ── Mutations (same endpoints/payloads as the desktop POS) ───────
  const clearTableMutation = useMutation({
    mutationFn: (vars: { id: number; name: string; phase: 'bus' | 'clean' }) =>
      apiFetch<{ table: RestaurantTable }>(`/api/tables/${vars.id}/clear`, {
        method: 'POST',
        body: { action: vars.phase },
      }),
    onSuccess: async (_data, vars) => {
      toast.success(
        vars.phase === 'bus'
          ? t('pos.tableBussedToast', { table: vars.name })
          : t('pos.tableCleanedToast', { table: vars.name }),
      )
      setClearTarget(null)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['floorplans'] }),
        queryClient.invalidateQueries({ queryKey: ['tables-status'] }),
        queryClient.invalidateQueries({ queryKey: ['orders'] }),
      ])
    },
    onError: (err: Error) => toast.error(err.message),
  })

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

  const cancelMutation = useMutation({
    mutationFn: (id: number) => apiFetch<{ order: Order }>(`/api/orders/${id}/cancel`, { method: 'POST' }),
    onSuccess: async () => {
      toast.success(t('pos.cancelToast'))
      setCancelTarget(null)
      if (mode === 'builder' && activeOrderId != null) backToFloor()
      await invalidateShared()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  // ── Guests dialog handlers ───────────────────────────────────────
  const openGuestsEdit = () => {
    setGuestsValue(order ? order.guests : guestsDraft)
    setGuestsTarget(order ? { kind: 'order', orderId: order.id } : { kind: 'draft' })
    setGuestsDialogOpen(true)
  }

  const confirmGuests = () => {
    const value = clampGuests(guestsValue)
    if (guestsTarget?.kind === 'new-table') {
      enterTableDraft(guestsTarget.table, value)
    } else if (guestsTarget?.kind === 'draft') {
      setGuestsDraft(value)
    } else if (guestsTarget?.kind === 'order' && order) {
      updateGuests.mutate({ id: order.id, guests: value })
    }
    setGuestsDialogOpen(false)
    setGuestsTarget(null)
  }

  // ── Draft lines (same merge rules as pos-view) ───────────────────
  const appendDraftLine = (p: Product, quantity: number, modifiers?: DraftItem['modifiers'], notes?: string) => {
    const sig = modifierSignature(modifiers)
    const trimmedNotes = notes?.trim() ?? ''
    setDraft((prev) => {
      const course = guessCourse(p)
      const existing =
        trimmedNotes === ''
          ? prev.find(
              (d) => d.productId === p.id && !d.notes && d.course === course && modifierSignature(d.modifiers) === sig,
            )
          : undefined
      if (existing) {
        return prev.map((d) => (d.key === existing.key ? { ...d, quantity: round2(d.quantity + quantity) } : d))
      }
      return [
        ...prev,
        {
          key: newDraftKey(),
          productId: p.id,
          name: p.name,
          nameAr: p.nameAr ?? null,
          price: p.price,
          quantity,
          notes: trimmedNotes,
          course,
          modifiers,
        },
      ]
    })
  }

  const addProduct = (p: Product) => {
    if ((p.modifierGroups ?? []).some((g) => g.active && g.modifiers.some((m) => m.active))) {
      setSheetProduct(p)
      return
    }
    appendDraftLine(p, 1)
  }

  const handleSheetConfirm = ({ product, quantity, modifiers, notes }: ModifierSheetSelection) => {
    appendDraftLine(product, quantity, modifiers.length > 0 ? modifiers : undefined, notes)
    setSheetProduct(null)
  }

  const changeQty = (d: DraftItem, delta: number) => {
    const next = round2(d.quantity + delta)
    if (next <= 0) setDraft((prev) => prev.filter((x) => x.key !== d.key))
    else setDraft((prev) => prev.map((x) => (x.key === d.key ? { ...x, quantity: next } : x)))
  }

  const draftToPayload = (d: DraftItem[]) =>
    d.map((item) => ({
      productId: item.productId,
      quantity: item.quantity,
      notes: item.notes.trim() || undefined,
      course: item.course,
      selectedModifiers: item.modifiers?.length ? item.modifiers : undefined,
    }))

  // ── Send to kitchen (payload shapes copied from pos-view) ────────
  const sendToKitchen = async (): Promise<Order | null> => {
    if (draft.length === 0 || sending) return order
    setSending(true)
    try {
      let result: { order: Order }
      const payloadBase = {
        items: draftToPayload(draft),
        guests: clampGuests(guestsDraft),
      }
      // R13 PWA: offline path — queue the creation and finish locally.
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        const tableless = selectedTable?.id == null
        const kind = orderKindRef.current
        enqueueOfflineAction({
          url: '/api/orders',
          method: 'POST',
          body:
            tableless && kind === 'delivery' && deliveryInfo
              ? { ...payloadBase, orderType: 'delivery', deliveryPhone: deliveryInfo.phone }
              : selectedTable?.id != null
                ? { ...payloadBase, tableId: selectedTable.id, orderType: 'dinein' }
                : { ...payloadBase, orderType: 'takeaway' },
          label: selectedTable?.name ?? 'order',
        })
        setDraft([])
        toast.info(t('offline.bannerSingle'))
        backToFloor()
        return null
      }
      if (!order) {
        const tableless = selectedTable?.id == null
        const delivery = tableless && orderKindRef.current === 'delivery' && deliveryInfo
        result = await apiFetch<{ order: Order }>('/api/orders', {
          method: 'POST',
          body: {
            tableId: selectedTable?.id ?? null,
            ...payloadBase,
            orderType: tableless ? (delivery ? 'delivery' : 'takeaway') : 'dinein',
            ...(delivery
              ? {
                  deliveryPhone: deliveryInfo.phone,
                  ...(deliveryInfo.address.trim() ? { deliveryAddress: deliveryInfo.address.trim() } : {}),
                }
              : {}),
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

  /** Pay from the builder / my orders — flush the draft first (same as desktop). */
  const handlePay = async (target: Order) => {
    if (sending) return
    let current: Order | null = order && target.id === order.id ? order : target
    if (order && target.id === order.id && draft.length > 0) {
      current = await sendToKitchen()
      if (!current) return
    }
    setPayOrder(current)
  }

  const handleBill = async (target: Order) => {
    if (sending) return
    let current: Order | null = order && target.id === order.id ? order : target
    if (order && target.id === order.id && draft.length > 0) {
      current = await sendToKitchen()
      if (!current) return
    }
    setCheckOrder(current)
  }

  const handlePaySuccess = async (updated: Order, closed: boolean) => {
    if (closed) {
      setReceiptOrder(updated)
      if (mode === 'builder' && activeOrderId === updated.id) backToFloor()
      setPayOrder(null)
      await invalidateShared()
    } else {
      queryClient.setQueryData(['pos-order', updated.id], { order: updated })
      setPayOrder(updated)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['orders'] }),
        queryClient.invalidateQueries({ queryKey: ['floorplans'] }),
      ])
    }
  }

  const canCancel = (o: Order) => user.role === 'admin' || (o.userId != null && o.userId === user.id)

  const cartTotals = computeCartTotals(order, draft)
  const draftCount = draft.reduce((n, d) => n + d.quantity, 0)
  const preparingCount = order?.items.filter((i) => i.status === 'preparing').length ?? 0
  const readyCount = order?.items.filter((i) => i.status === 'ready').length ?? 0

  // ── My Orders (open orders owned by this waiter) ─────────────────
  const myOrders = useMemo(
    () => openOrders.filter((o) => o.status === 'open' && o.user?.id === user.id),
    [openOrders, user.id],
  )

  // ── Shared modals — mounted in EVERY portal branch (floor, builder,
  // my orders) so guests-edit / bill / pay / cancel work from any screen.
  const sharedModals = (
    <>
      {/* Guests quick dialog (free-table seating / guests edit) */}
      <GuestsDialog
        open={guestsDialogOpen}
        value={guestsValue}
        pending={updateGuests.isPending}
        onValueChange={setGuestsValue}
        onConfirm={confirmGuests}
        onCancel={() => {
          setGuestsDialogOpen(false)
          setGuestsTarget(null)
        }}
      />
      {payOrder && (
        <PaymentModal
          order={payOrder}
          open={!!payOrder}
          onOpenChange={(o) => {
            if (!o) setPayOrder(null)
          }}
          onSuccess={(updated, closed) => void handlePaySuccess(updated, closed)}
          onDeferred={() => {
            setPayOrder(null)
            if (mode === 'builder') backToFloor()
            void invalidateShared()
          }}
        />
      )}
      {checkOrder && (
        <CheckModal
          key={checkOrder.id}
          order={checkOrder}
          open={!!checkOrder}
          onOpenChange={(o) => {
            if (!o) setCheckOrder(null)
          }}
        />
      )}
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
      {/* Cancel confirm (builder + my orders) */}
      <AlertDialog open={cancelTarget != null} onOpenChange={(o) => !o && setCancelTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('pos.cancelTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('pos.cancelDesc', {
                order: cancelTarget?.id ?? 0,
                table: cancelTarget?.table?.name ?? t('common.takeaway'),
                total: formatCurrency(cancelTarget?.totalAmount ?? 0),
                items: cancelTarget?.items.length ?? 0,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelMutation.isPending}>{t('pos.keepOrder')}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              disabled={cancelMutation.isPending}
              onClick={(e) => {
                e.preventDefault()
                if (cancelTarget) cancelMutation.mutate(cancelTarget.id)
              }}
            >
              {cancelMutation.isPending && <Loader2 className="animate-spin" />} {t('pos.cancelOrder')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )

  // ── Render dispatch ──────────────────────────────────────────────
  // The My Orders tab renders over the portal (builder state survives).
  if (active && tab === 'orders') {
    return (
      <>
        <MyOrdersScreen
          orders={myOrders}
          loading={openOrdersData == null && !openOrdersError}
          error={openOrdersError}
          onRefresh={() => void refetchOpenOrders()}
          onAddItems={(o) => {
            openOrder(o)
            onSwitchTab('tables')
          }}
          onBill={(o) => void handleBill(o)}
          onPay={(o) => void handlePay(o)}
          onCancel={(o) => setCancelTarget(o)}
          canCancel={canCancel}
        />
        {sharedModals}
      </>
    )
  }

  if (mode === 'builder') {
    return (
      <>
      <div className="flex h-full min-h-0 flex-col" data-tick={elapsedTick}>
        {/* ── Builder header ── */}
        <header className="sticky top-0 z-10 shrink-0 border-b border-border bg-card px-3 py-2 shadow-sm">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              className="h-11 shrink-0 rounded-xl px-2 text-primary hover:bg-primary/10"
              onClick={backToFloor}
              aria-label={t('m.backToTables')}
            >
              <span aria-hidden className="text-xl leading-none rtl:rotate-180">
                ←
              </span>
            </Button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-base font-bold leading-tight">{selectedTable?.name ?? t('pos.order')}</p>
              <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                {order && <span className="font-semibold tabular-nums">#{order.id}</span>}
                {order && (
                  <span className="tabular-nums" data-tick={elapsedTick}>
                    {elapsedSince(order.createdAt)}
                  </span>
                )}
                <span className="tabular-nums">
                  · {t('common.guests')}: {order ? order.guests : guestsDraft}
                </span>
              </p>
            </div>
            <Button
              variant="outline"
              size="icon"
              className="size-11 shrink-0 rounded-xl border-primary/40 text-primary hover:bg-primary/10 hover:text-primary"
              onClick={openGuestsEdit}
              aria-label={t('pos.editGuests')}
            >
              <Users className="size-5" />
            </Button>
            {order && canCancel(order) && (
              <Button
                variant="outline"
                size="icon"
                className="size-11 shrink-0 rounded-xl border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => setCancelTarget(order)}
                aria-label={t('common.cancel')}
              >
                <Ban className="size-5" />
              </Button>
            )}
          </div>
          {(preparingCount > 0 || readyCount > 0) && (
            <div className="mt-1 flex items-center gap-1.5 px-1">
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
          )}
        </header>

        {/* ── Products ── */}
        <BuilderProducts
          products={products}
          loading={productsQuery.isLoading && products.length === 0}
          onAdd={addProduct}
        />

        {/* ── Sticky cart bar (sits right above the bottom tab bar) ── */}
        <div className="shrink-0 border-t border-border bg-card/95 px-3 py-2.5 backdrop-blur">
          <button
            type="button"
            onClick={() => setCartOpen(true)}
            className="flex h-12 w-full items-center gap-3 rounded-2xl bg-primary px-4 text-white shadow-md transition active:scale-[0.98]"
            aria-label={t('m.viewCart')}
          >
            <span className="relative shrink-0">
              <ShoppingBag className="size-5" aria-hidden />
              {draftCount > 0 && (
                <span className="absolute -end-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full bg-white text-[10px] font-bold tabular-nums text-primary">
                  {draft.length}
                </span>
              )}
            </span>
            <span className="min-w-0 flex-1 overflow-hidden text-start">
              <span className="block truncate text-sm font-semibold">
                {draftCount > 0 ? t('m.cartCount', { n: formatQty(draftCount) }) : t('m.viewCart')}
              </span>
            </span>
            <span className="shrink-0 text-sm font-bold tabular-nums">{formatCurrency(cartTotals.total)}</span>
          </button>
        </div>

        {/* ── Cart sheet (bottom, tall) ── */}
        <Sheet open={cartOpen} onOpenChange={setCartOpen}>
          <SheetContent side="bottom" className="flex max-h-[88dvh] flex-col rounded-t-3xl px-0">
            <SheetHeader className="px-4 pb-2">
              <SheetTitle className="flex items-center gap-2 text-base">
                <ShoppingBag className="size-4 text-primary" aria-hidden />
                {selectedTable?.name ?? t('pos.order')}
                {order && <span className="tabular-nums text-muted-foreground">#{order.id}</span>}
              </SheetTitle>
            </SheetHeader>
            <div className="rms-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-2">
              {orderLoading && !order && draft.length === 0 ? (
                <div className="space-y-2 py-2">
                  <Skeleton className="h-14 w-full rounded-xl" />
                  <Skeleton className="h-14 w-full rounded-xl" />
                </div>
              ) : (order?.items.length ?? 0) + draft.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {order ? t('m.cartEmptyOrder') : t('m.cartEmpty')}
                </p>
              ) : (
                <>
                  {/* Sent lines (live order) — includes the ✓ sent state */}
                  {order?.items.map((item) => (
                    <SentLine key={item.id} item={item} />
                  ))}
                  {/* Draft lines */}
                  {draft.map((d) => (
                    <DraftLine key={d.key} line={d} onChange={changeQty} />
                  ))}
                </>
              )}
            </div>
            <div className="shrink-0 space-y-2 border-t border-border bg-card px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
              <div className="space-y-0.5 text-xs text-muted-foreground">
                <p className="flex justify-between tabular-nums">
                  <span>{t('money.subtotal')}</span>
                  <span>{formatCurrency(cartTotals.subtotal)}</span>
                </p>
                <p className="flex justify-between tabular-nums">
                  <span>{t('money.tax')}</span>
                  <span>{formatCurrency(cartTotals.tax)}</span>
                </p>
                <p className="flex justify-between tabular-nums">
                  <span>{t('money.serviceTax')}</span>
                  <span>{formatCurrency(cartTotals.serviceTax)}</span>
                </p>
                <p className="flex justify-between text-sm font-bold text-foreground">
                  <span>{t('m.runningTotal')}</span>
                  <span className="tabular-nums text-primary">{formatCurrency(cartTotals.total)}</span>
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  variant="outline"
                  className="h-11 rounded-xl border-primary/40 text-primary hover:bg-primary/10 hover:text-primary"
                  disabled={!order}
                  onClick={() => order && void handleBill(order)}
                >
                  <ReceiptText className="size-4" /> {t('m.bill')}
                </Button>
                <Button
                  variant="outline"
                  className="h-11 rounded-xl border-emerald-300 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-700"
                  disabled={!order}
                  onClick={() => order && void handlePay(order)}
                >
                  <Wallet className="size-4" /> {t('m.pay')}
                </Button>
              </div>
              <Button
                className="h-12 w-full rounded-xl bg-primary text-base font-semibold text-white hover:bg-primary/90"
                disabled={draft.length === 0 || sending}
                onClick={() => void sendToKitchen()}
              >
                {sending ? <Loader2 className="size-5 animate-spin" /> : <Send className="size-5" />}{' '}
                {sending ? t('m.sending') : t('m.sendToKitchen')}
              </Button>
            </div>
          </SheetContent>
        </Sheet>

        {/* ── Modifier sheet (reused from the desktop POS) ── */}
        <ModifierSheet
          key={sheetProduct?.id ?? 'closed'}
          open={!!sheetProduct}
          product={sheetProduct}
          onOpenChange={(o) => {
            if (!o) setSheetProduct(null)
          }}
          onConfirm={handleSheetConfirm}
        />
      </div>
      {sharedModals}
    </>
  )
  }

  // ── Floor screen (+ its floor-only dialogs + shared order modals) ──
  return (
    <>
      <div className="rms-scroll h-full overflow-y-auto" data-tick={elapsedTick}>
        <FloorScreen
          floorPlans={floorPlanData?.floorPlans ?? []}
          loading={floorLoading}
          error={floorError}
          onRetry={() => void refetchFloor()}
          onSelectTable={selectTable}
          onTakeaway={startTakeaway}
          onDelivery={() => setDeliveryOpen(true)}
        />

          {/* Multi-order picker (several open orders on one table) */}
        <Dialog open={pickerOrders != null} onOpenChange={(o) => !o && setPickerOrders(null)}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>{t('m.pickOrder')}</DialogTitle>
              <DialogDescription>
                {t('m.openOrdersOnTable', { n: pickerOrders?.length ?? 0, table: pickerOrders?.[0]?.table?.name ?? '' })}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              {pickerOrders?.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => {
                    setPickerOrders(null)
                    openOrder(o)
                  }}
                  className="flex min-h-11 w-full items-center justify-between gap-2 rounded-xl border border-border bg-white px-3 py-2 text-start text-sm shadow-sm transition hover:border-primary/50 active:scale-[0.98]"
                >
                  <span className="min-w-0">
                    <span className="block font-semibold tabular-nums">#{o.id}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {o.table?.name ?? (o.orderType === 'delivery' ? t('m.newDelivery') : t('common.takeaway'))} ·{' '}
                      {elapsedSince(o.createdAt)}
                    </span>
                  </span>
                  <span className="shrink-0 font-bold tabular-nums text-primary">
                    {formatCurrency(o.remainingAmount)}
                  </span>
                </button>
              ))}
            </div>
          </DialogContent>
        </Dialog>

        {/* New delivery dialog — phone required, address optional (same rules as the POS) */}
        <Dialog open={deliveryOpen} onOpenChange={setDeliveryOpen}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Bike className="size-5 text-primary" /> {t('pos.newDeliveryOrder')}
              </DialogTitle>
              <DialogDescription>{t('pos.deliveryAddressPh')}</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="grid gap-2">
                <Label htmlFor="m-delivery-phone">{t('pos.deliveryPhone')} *</Label>
                <Input
                  id="m-delivery-phone"
                  type="tel"
                  inputMode="tel"
                  value={deliveryPhone}
                  onChange={(e) => setDeliveryPhone(e.target.value)}
                  placeholder={t('pos.deliveryPhonePh')}
                  maxLength={20}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      confirmDelivery()
                    }
                  }}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="m-delivery-address">{t('pos.deliveryAddress')}</Label>
                <Input
                  id="m-delivery-address"
                  value={deliveryAddress}
                  onChange={(e) => setDeliveryAddress(e.target.value)}
                  placeholder={t('pos.deliveryAddressPh')}
                  maxLength={200}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" className="h-11" onClick={() => setDeliveryOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                className="h-11 bg-primary text-white hover:bg-primary/90"
                disabled={deliveryPhone.trim().length < 5 || deliveryPhone.trim().length > 20}
                onClick={confirmDelivery}
              >
                <Bike className="size-4" /> {t('pos.deliveryStart')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Manual turnover confirm (paid/deferred → bus, dirty → clean) */}
        <AlertDialog
          open={clearTarget != null}
          onOpenChange={(o) => {
            if (!o && !clearTableMutation.isPending) setClearTarget(null)
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {clearTarget?.status === 'dirty'
                  ? t('pos.cleanTableTitle', { table: clearTarget?.name ?? '' })
                  : t('pos.busTableTitle', { table: clearTarget?.name ?? '' })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {clearTarget?.status === 'dirty'
                  ? t('pos.cleanTableDesc')
                  : clearTarget?.status === 'paid'
                    ? t('pos.busTablePaidDesc')
                    : t('pos.clearTableDeferredDesc', { client: clearTarget?.deferredClientName ?? '—' })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={clearTableMutation.isPending}>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction
                className={cn(
                  clearTarget?.status === 'dirty'
                    ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                    : 'bg-amber-600 text-white hover:bg-amber-700',
                )}
                disabled={clearTableMutation.isPending}
                onClick={(e) => {
                  e.preventDefault()
                  if (clearTarget) {
                    clearTableMutation.mutate({
                      id: clearTarget.id,
                      name: clearTarget.name,
                      phase: clearTarget.status === 'dirty' ? 'clean' : 'bus',
                    })
                  }
                }}
              >
                {clearTableMutation.isPending && <Loader2 className="size-4 animate-spin" />}{' '}
                {clearTarget?.status === 'dirty' ? t('pos.markCleanedFree') : t('pos.sendToCleaning')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
      {sharedModals}
    </>
  )
}

// ─── Floor screen ─────────────────────────────────────────────────────

function FloorScreen({
  floorPlans,
  loading,
  error,
  onRetry,
  onSelectTable,
  onTakeaway,
  onDelivery,
}: {
  floorPlans: FloorPlan[]
  loading: boolean
  error?: boolean
  onRetry?: () => void
  onSelectTable: (table: RestaurantTable) => void
  onTakeaway: () => void
  onDelivery: () => void
}) {
  const { t } = useI18n()
  const [floorIdx, setFloorIdx] = useState(0)

  const idx = floorPlans.length > 0 ? Math.min(floorIdx, floorPlans.length - 1) : 0
  const plan = floorPlans[idx] ?? null
  const tables = plan?.tables ?? []

  const freeCount = tables.filter((tb) => tb.status === 'free' && tb.openOrderId == null).length
  const busyCount = tables.filter((tb) => tb.status === 'occupied' || tb.openOrderId != null).length

  return (
    <div className="flex flex-col gap-3 p-3">
      {/* Floor chips + table-less order kinds */}
      <div className="rms-scroll flex items-center gap-2 overflow-x-auto pb-1" role="tablist" aria-label={t('pos.floors')}>
        {floorPlans.map((fp, i) => (
          <button
            key={fp.id}
            type="button"
            role="tab"
            aria-selected={i === idx}
            onClick={() => setFloorIdx(i)}
            className={cn(
              'h-11 shrink-0 rounded-full border px-4 text-sm font-semibold shadow-sm transition active:scale-95',
              i === idx ? 'border-primary bg-primary text-white' : 'border-border bg-white text-stone-600',
            )}
          >
            {fp.name}
          </button>
        ))}
        <span className="mx-1 h-6 w-px shrink-0 bg-border" aria-hidden />
        <button
          type="button"
          onClick={onTakeaway}
          className="flex h-11 shrink-0 items-center gap-1.5 rounded-full border border-emerald-300 bg-emerald-50 px-4 text-sm font-semibold text-emerald-700 shadow-sm transition active:scale-95"
        >
          <ShoppingBag className="size-4" aria-hidden /> {t('m.newTakeaway')}
        </button>
        <button
          type="button"
          onClick={onDelivery}
          className="flex h-11 shrink-0 items-center gap-1.5 rounded-full border border-primary/40 bg-primary/[0.06] px-4 text-sm font-semibold text-primary shadow-sm transition active:scale-95"
        >
          <Bike className="size-4" aria-hidden /> {t('m.newDelivery')}
        </button>
      </div>

      {/* Hall stats (current floor) */}
      {plan && (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-xs font-medium text-stone-500">
          <span className="tabular-nums">{t('m.tablesCount', { n: tables.length })}</span>
          <span className="tabular-nums font-semibold text-emerald-700">{t('m.floorFree', { n: freeCount })}</span>
          <span className="tabular-nums font-semibold text-amber-700">{t('m.floorBusy', { n: busyCount })}</span>
        </p>
      )}

      {/* Table grid */}
      {loading ? (
        <div className="grid grid-cols-2 gap-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-28 rounded-2xl" />
          ))}
        </div>
      ) : error ? (
        // R16: real error state (was: fell through to the empty state)
        <div className="flex min-h-[220px] flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-destructive/40 px-6 py-8 text-center">
          <WifiOff className="size-8 text-destructive" aria-hidden />
          <p className="text-sm font-medium text-destructive">{t('pos.floorLoadError')}</p>
          <Button variant="outline" className="h-11 rounded-xl" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        </div>
      ) : floorPlans.length === 0 ? (
        <EmptyState icon={Armchair} title={t('pos.noTables')} />
      ) : tables.length === 0 ? (
        <EmptyState icon={Armchair} title={t('pos.noTablesFloor')} />
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {tables.map((tb) => (
            <FloorTableTile key={tb.id} table={tb} onClick={() => onSelectTable(tb)} />
          ))}
        </div>
      )}
    </div>
  )
}

/** Mobile table tile — mirrors the desktop TableTile states, 2-col layout. */
function FloorTableTile({ table, onClick }: { table: RestaurantTable; onClick: () => void }) {
  const { t } = useI18n()
  const occupied = table.status === 'occupied' || table.openOrderId != null
  const reserved = table.status === 'reserved' && table.openOrderId == null
  const paid = table.status === 'paid' && table.openOrderId == null
  const deferred = table.status === 'deferred' && table.openOrderId == null
  const dirty = table.status === 'dirty' && table.openOrderId == null

  const mins =
    occupied && table.openOrderSince
      ? Math.max(0, (Date.now() - new Date(table.openOrderSince).getTime()) / 60000)
      : 0
  const heat = occupied ? occupancyHeat(mins) : null

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'relative flex min-h-28 flex-col items-center justify-center gap-1 overflow-hidden rounded-2xl border p-3 text-center shadow-sm transition hover:shadow-md active:scale-[0.97]',
        occupied && heat
          ? cn(heat.tile, heat.text)
          : paid
            ? 'border-emerald-600 bg-emerald-600 text-white'
            : deferred
              ? 'border-violet-400 bg-violet-100 text-violet-900 ring-1 ring-violet-400'
              : dirty
                ? 'border-amber-500 bg-amber-200 text-amber-900 ring-2 ring-amber-400'
                : reserved
                  ? 'border-amber-300 bg-amber-50/70 text-amber-900 ring-1 ring-amber-400'
                  : 'border-border bg-white text-stone-500',
      )}
    >
      <p className="max-w-full truncate text-base font-bold leading-tight">{table.name}</p>

      {!occupied && !reserved && !paid && !deferred && !dirty && (
        <p className="flex items-center gap-1 text-xs text-stone-400">
          <Users className="size-3.5" aria-hidden />
          {table.capacity} {t('common.seats')}
        </p>
      )}

      {occupied && (
        <>
          <p className={cn('text-lg font-extrabold tabular-nums leading-none', heat?.amount)}>
            {formatCurrency(table.openOrderTotal ?? 0)}
          </p>
          <p className={cn('flex items-center justify-center gap-1.5 text-[11px]', heat?.meta)}>
            <Users className="size-3.5" aria-hidden />
            {table.openOrderGuests ?? '—'}
            <span aria-hidden>·</span>
            <Clock className="size-3" aria-hidden />
            {table.openOrderSince ? elapsedSince(table.openOrderSince) : t('pos.open')}
          </p>
          {table.openOrderMerged && (
            <span className="absolute end-1.5 top-1.5 inline-flex items-center gap-0.5 rounded-full bg-black/10 px-1.5 py-0.5 text-[9px] font-bold uppercase">
              <Armchair className="size-2.5" aria-hidden />
              {t('pos.mergedBadge')}
            </span>
          )}
        </>
      )}

      {reserved && (
        <span className="inline-flex items-center gap-1 rounded-full border border-amber-400/60 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-600">
          <Clock className="size-3" aria-hidden />
          {t('status.table.reserved')}
        </span>
      )}
      {paid && (
        <span className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 text-[10px] font-semibold text-white ring-1 ring-white/30">
          <BadgeCheck className="size-3.5" aria-hidden />
          {t('m.tablePaidBadge')}
        </span>
      )}
      {deferred && (
        <span className="inline-flex items-center gap-1 rounded-full border border-violet-300 bg-white px-2 py-0.5 text-[10px] font-semibold text-violet-700">
          <Hourglass className="size-3" aria-hidden />
          {t('pos.tableDeferredBadge')}
        </span>
      )}
      {dirty && (
        <span className="inline-flex items-center gap-1 rounded-full border border-amber-600/40 bg-white/80 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
          <Brush className="size-3" aria-hidden />
          {t('m.tableDirtyBadge')}
        </span>
      )}
    </button>
  )
}

// ─── Builder products (category chips + 2-col grid) ───────────────────

function BuilderProducts({
  products,
  loading,
  onAdd,
}: {
  products: Product[]
  loading: boolean
  onAdd: (product: Product) => void
}) {
  const { t, lang } = useI18n()
  const [category, setCategory] = useState<string>('all')

  const categories = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>()
    for (const p of products) {
      const cat = p.category
      if (!cat) continue
      const id = String(cat.id)
      if (!map.has(id)) map.set(id, { id, name: localizedName(cat.name, cat.nameAr, lang) })
    }
    return Array.from(map.values())
  }, [products, lang])

  const visible = useMemo(
    () => (category === 'all' ? products : products.filter((p) => p.category && String(p.category.id) === category)),
    [products, category],
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Category chips (horizontal scroll) */}
      <div className="rms-scroll flex shrink-0 items-center gap-2 overflow-x-auto border-b border-border bg-card px-3 py-2" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={category === 'all'}
          onClick={() => setCategory('all')}
          className={cn(
            'h-9 shrink-0 rounded-full border px-3.5 text-sm font-semibold transition active:scale-95',
            category === 'all' ? 'border-primary bg-primary text-white' : 'border-border bg-white text-stone-600',
          )}
        >
          {t('m.allCategories')}
        </button>
        {categories.map((c) => (
          <button
            key={c.id}
            type="button"
            role="tab"
            aria-selected={category === c.id}
            onClick={() => setCategory(c.id)}
            className={cn(
              'h-9 shrink-0 rounded-full border px-3.5 text-sm font-semibold transition active:scale-95',
              category === c.id ? 'border-primary bg-primary text-white' : 'border-border bg-white text-stone-600',
            )}
          >
            {c.name}
          </button>
        ))}
      </div>

      {/* Product grid (2 cols, ~88px tiles, sold-out overlay) */}
      <div className="rms-scroll min-h-0 flex-1 overflow-y-auto p-3">
        {loading ? (
          <div className="grid grid-cols-2 gap-2.5">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-[88px] rounded-2xl" />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <EmptyState icon={Utensils} title={t('pos.noProducts')} />
        ) : (
          <div className="grid grid-cols-2 gap-2.5">
            {visible.map((p) => {
              const soldOut = !!p.soldOut
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={soldOut}
                  onClick={() => onAdd(p)}
                  className={cn(
                    'flex h-[88px] flex-col justify-between rounded-2xl border p-3 text-start shadow-sm transition hover:shadow-md active:scale-[0.97]',
                    soldOut
                      ? 'cursor-not-allowed border-border bg-muted/60 text-muted-foreground'
                      : 'border-border bg-white text-stone-700',
                  )}
                >
                  <span className="line-clamp-2 min-w-0 text-sm font-semibold leading-snug">
                    {localizedName(p.name, p.nameAr, lang)}
                  </span>
                  <span className="flex items-center justify-between gap-1">
                    <span
                      className={cn(
                        'text-sm font-bold tabular-nums',
                        soldOut ? 'text-muted-foreground' : 'text-primary',
                      )}
                    >
                      {formatCurrency(p.price)}
                    </span>
                    {soldOut && (
                      <span className="rounded-full border border-stone-300 bg-white px-1.5 py-0.5 text-[9px] font-bold uppercase text-stone-500">
                        {t('pos.soldOut')}
                      </span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Cart lines ───────────────────────────────────────────────────────

/** Sent line (live order) — status chip + qty × name + modifiers + note. */
function SentLine({ item }: { item: Order['items'][number] }) {
  const { t, lang } = useI18n()
  const chip = STATUS_CHIP[item.status] ?? STATUS_CHIP.served
  const mods = item.selectedModifiers ?? []
  return (
    <div className="border-b border-border/60 py-2.5 last:border-b-0">
      <div className="flex items-start gap-2">
        <span
          className={cn(
            'mt-0.5 flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
            chip,
          )}
        >
          {item.status === 'new' && <Check className="size-2.5" aria-hidden />}
          {t(`status.item.${item.status}`)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {formatQty(item.quantity)} ×{' '}
            {item.product ? localizedName(item.product.name, item.product.nameAr, lang) : t('pos.item')}
          </p>
          {mods.length > 0 && (
            <p className="mt-0.5 flex flex-wrap gap-1 text-[11px] text-muted-foreground">
              {mods.map((m, i) => (
                <span key={`${m.id}-${i}`} className="rounded border border-border bg-muted/50 px-1 py-0 leading-4">
                  {localizedName(m.name, m.nameAr, lang)}
                </span>
              ))}
            </p>
          )}
          {item.notes && (
            <p className="mt-0.5 truncate text-xs font-medium text-amber-600" title={item.notes}>
              “{item.notes}”
            </p>
          )}
        </div>
        <span className="shrink-0 text-sm font-semibold tabular-nums">
          {formatCurrency(round2(item.quantity * item.unitPrice))}
        </span>
      </div>
    </div>
  )
}

/** Draft line — qty steppers (44px), remove on 0 (same guard as the desktop cart). */
function DraftLine({
  line,
  onChange,
}: {
  line: DraftItem
  onChange: (line: DraftItem, delta: number) => void
}) {
  const { t, lang } = useI18n()
  const mods = line.modifiers ?? []
  return (
    <div className="border-b border-border/60 py-2.5 last:border-b-0">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{localizedName(line.name, line.nameAr, lang)}</p>
          {mods.length > 0 && (
            <p className="mt-0.5 flex flex-wrap gap-1 text-[11px] text-muted-foreground">
              {mods.map((m, i) => (
                <span key={`${m.id}-${i}`} className="rounded border border-border bg-muted/50 px-1 py-0 leading-4">
                  {localizedName(m.name, m.nameAr, lang)}
                </span>
              ))}
            </p>
          )}
          {line.notes && (
            <p className="mt-0.5 truncate text-xs font-medium text-amber-600" title={line.notes}>
              “{line.notes}”
            </p>
          )}
          <p className="mt-0.5 text-xs font-semibold tabular-nums text-primary">
            {formatCurrency(lineUnitPrice(line))}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <span className="text-sm font-bold tabular-nums">
            {formatCurrency(round2(line.quantity * lineUnitPrice(line)))}
          </span>
          <div className="flex items-center gap-1" role="group" aria-label={t('pos.modQty')}>
            <Button
              variant="outline"
              size="icon"
              className="size-11 rounded-xl"
              onClick={() => onChange(line, -1)}
              aria-label={t('m.decreaseQty')}
            >
              <Minus className="size-4" />
            </Button>
            <span className="w-8 text-center text-base font-bold tabular-nums">{formatQty(line.quantity)}</span>
            <Button
              variant="outline"
              size="icon"
              className="size-11 rounded-xl"
              onClick={() => onChange(line, 1)}
              aria-label={t('m.increaseQty')}
            >
              <Plus className="size-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── My Orders screen ─────────────────────────────────────────────────

function MyOrdersScreen({
  orders,
  loading,
  error,
  onRefresh,
  onAddItems,
  onBill,
  onPay,
  onCancel,
  canCancel,
}: {
  orders: Order[]
  loading: boolean
  error?: boolean
  onRefresh: () => void
  onAddItems: (order: Order) => void
  onBill: (order: Order) => void
  onPay: (order: Order) => void
  onCancel: (order: Order) => void
  canCancel: (order: Order) => boolean
}) {
  const { t } = useI18n()

  return (
    <div className="rms-scroll h-full overflow-y-auto p-3">
      <div className="mb-3 flex items-center justify-between gap-2 px-1">
        <h2 className="text-base font-bold">{t('m.myOrdersTitle')}</h2>
        <Button
          variant="outline"
          size="icon"
          className="size-11 rounded-xl border-primary/40 text-primary hover:bg-primary/10 hover:text-primary"
          onClick={onRefresh}
          aria-label={t('m.refresh')}
        >
          <RefreshCw className="size-4" />
        </Button>
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-32 w-full rounded-2xl" />
          ))}
        </div>
      ) : error ? (
        // R16: real error state (was: fell through to the empty state)
        <div className="flex min-h-[220px] flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-destructive/40 px-6 py-8 text-center">
          <WifiOff className="size-8 text-destructive" aria-hidden />
          <p className="text-sm font-medium text-destructive">{t('m.myOrdersError')}</p>
          <Button variant="outline" className="h-11 rounded-xl" onClick={onRefresh}>
            {t('common.retry')}
          </Button>
        </div>
      ) : orders.length === 0 ? (
        <EmptyState icon={ClipboardList} title={t('m.myOrdersEmpty')} hint={t('m.myOrdersEmptyHint')} />
      ) : (
        <ul className="space-y-3">
          {orders.map((o) => (
            <li key={o.id} className="rounded-2xl border border-border bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-sm font-bold">
                    {o.table ? (
                      <>
                        <Armchair className="size-4 shrink-0 text-primary" aria-hidden />
                        <span className="truncate">{o.table.name}</span>
                      </>
                    ) : o.orderType === 'delivery' ? (
                      <>
                        <Bike className="size-4 shrink-0 text-primary" aria-hidden />
                        <span className="truncate">{o.deliveryPhone ?? t('m.newDelivery')}</span>
                      </>
                    ) : (
                      <>
                        <ShoppingBag className="size-4 shrink-0 text-primary" aria-hidden />
                        <span className="truncate">{t('common.takeaway')}</span>
                      </>
                    )}
                  </p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                    <span className="font-semibold tabular-nums">#{o.id}</span>
                    <span className="tabular-nums">{elapsedSince(o.createdAt)}</span>
                    <span className="tabular-nums">· {t('m.itemsCount', { n: o.items.length })}</span>
                    <span className="tabular-nums">· {t('m.guestsCount', { n: o.guests })}</span>
                  </p>
                </div>
                <span className="shrink-0 text-base font-extrabold tabular-nums text-primary">
                  {formatCurrency(o.remainingAmount)}
                </span>
              </div>

              <div className="mt-3 grid grid-cols-4 gap-1.5">
                <Button
                  variant="outline"
                  className="h-11 flex-col gap-0 rounded-xl border-primary/40 px-1 text-[10px] font-semibold text-primary hover:bg-primary/10 hover:text-primary"
                  onClick={() => onAddItems(o)}
                >
                  <Plus className="size-4" aria-hidden /> {t('m.addItems')}
                </Button>
                <Button
                  variant="outline"
                  className="h-11 flex-col gap-0 rounded-xl px-1 text-[10px] font-semibold"
                  onClick={() => onBill(o)}
                >
                  <ReceiptText className="size-4" aria-hidden /> {t('m.bill')}
                </Button>
                <Button
                  variant="outline"
                  className="h-11 flex-col gap-0 rounded-xl border-emerald-300 px-1 text-[10px] font-semibold text-emerald-700 hover:bg-emerald-50 hover:text-emerald-700"
                  onClick={() => onPay(o)}
                >
                  <Wallet className="size-4" aria-hidden /> {t('m.pay')}
                </Button>
                {canCancel(o) ? (
                  <Button
                    variant="outline"
                    className="h-11 flex-col gap-0 rounded-xl border-destructive/40 px-1 text-[10px] font-semibold text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => onCancel(o)}
                  >
                    <Ban className="size-4" aria-hidden /> {t('common.cancel')}
                  </Button>
                ) : (
                  <span aria-hidden />
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ─── Shared bits ──────────────────────────────────────────────────────

/** Guests quick picker — stepper + 1-8 chips (mirrors the POS guests dialog). */
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
            <Users className="size-5 text-primary" /> {t('m.seatGuests')}
          </DialogTitle>
          <DialogDescription>{t('m.seatGuestsDesc')}</DialogDescription>
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
                    ? 'border-primary bg-primary text-white'
                    : 'border-border bg-white text-stone-600 hover:border-primary/40',
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
          <Button className="bg-primary text-white hover:bg-primary/90" onClick={onConfirm} disabled={pending}>
            {pending ? <Loader2 className="animate-spin" /> : <Check />} {t('common.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** r13-style empty state (dashed box + icon + hint). */
function EmptyState({
  icon: Icon,
  title,
  hint,
}: {
  icon: typeof Armchair
  title: string
  hint?: string
}) {
  return (
    <div className="flex min-h-[220px] flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border px-6 py-8 text-center text-muted-foreground">
      <Icon className="size-8 opacity-40" aria-hidden />
      <p className="text-sm font-medium">{title}</p>
      {hint && <p className="text-xs">{hint}</p>}
    </div>
  )
}
