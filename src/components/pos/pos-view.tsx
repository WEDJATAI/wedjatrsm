'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeftRight, Ban, Check, ChevronLeft, Combine, Loader2, Minus, Plus, Users } from 'lucide-react'

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
import { currentNav, onNav, pushNav, replaceNav, type NavHash } from '@/lib/nav'
import { enqueueOfflineAction } from '@/lib/offline-queue'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import type { Customer, FloorPlan, Order, Product, RestaurantTable, SelectedModifier, SessionUser } from '@/lib/types'
import CartPanel from './cart-panel'
import CheckModal from './check-modal'
import ModifierSheet, { type ModifierSheetSelection } from './modifier-sheet'
import PaymentModal from './payment-modal'
import MyShiftSheet from './my-shift-sheet'
import ReceiptModal from './receipt-modal'
import ProductGrid from './product-grid'
import TableSelect from './table-select'
import { guessCourse, modifierSignature, newDraftKey, round2, type DraftItem } from './pos-utils'

/** Who the guests dialog edits: a fresh table draft, the unsent draft guest
 *  count, the persisted guests value of an existing order, or a Seat Party
 *  (multi-table seating) about to enter order mode. */
type GuestsTarget =
  | { kind: 'new-table'; table: RestaurantTable }
  | { kind: 'draft' }
  | { kind: 'order'; orderId: number }
  | { kind: 'seat-party' }
  | null

const GUEST_QUICK_CHIPS = [1, 2, 3, 4, 5, 6, 7, 8]

/** Table-less order kinds (R11): takeaway + delivery both skip tables. */
type OrderKind = 'dinein' | 'takeaway' | 'delivery'

const DELIVERY_INFO_KEY = 'rms-delivery-info'

/** Persist the delivery contact for this tab (survives a reload on
 *  '#/pos/delivery' so the screen can be restored after a refresh). */
function persistDeliveryInfo(info: { phone: string; address: string } | null): void {
  try {
    if (info) window.sessionStorage.setItem(DELIVERY_INFO_KEY, JSON.stringify(info))
    else window.sessionStorage.removeItem(DELIVERY_INFO_KEY)
  } catch {
    // storage unavailable — in-memory state still covers the session
  }
}

function readDeliveryInfo(): { phone: string; address: string } | null {
  try {
    const raw = window.sessionStorage.getItem(DELIVERY_INFO_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && typeof (parsed as { phone?: unknown }).phone === 'string') {
      const address = (parsed as { address?: unknown }).address
      return {
        phone: (parsed as { phone: string }).phone,
        address: typeof address === 'string' ? address : '',
      }
    }
  } catch {
    // corrupt entry — ignore
  }
  return null
}

/** `active` — true while the POS view is the visible top-level view. page.tsx
 *  keeps PosView mounted (hidden) when the user switches views so the order
 *  state survives; defaults to true when the prop is not passed. */
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

export default function PosView({ active = true }: { active?: boolean }) {
  const queryClient = useQueryClient()
  const { t } = useI18n()

  // ── State machine ────────────────────────────────────────────────
  const [mode, setMode] = useState<'tables' | 'order'>('tables')
  const [selectedTable, setSelectedTable] = useState<{ id: number | null; name: string } | null>(null)
  const [activeOrderId, setActiveOrderId] = useState<number | null>(null)
  const [draft, setDraft] = useState<DraftItem[]>([])
  const [sending, setSending] = useState(false)
  // R13: loyalty — customer attached to the DRAFT (sent with the create
  // payload; existing orders attach via PUT /api/orders/[id]).
  const [draftCustomer, setDraftCustomer] = useState<Customer | null>(null)

  // Guest count for the order that will be created from this screen
  // (takeaway defaults to 1, table drafts to the dialog value).
  const [guestsDraft, setGuestsDraft] = useState(2)

  // Guests dialog (create-before-order-mode + edit on the order screen).
  const [guestsDialogOpen, setGuestsDialogOpen] = useState(false)
  // R8: per-server shift closeout sheet ("My shift" button on the floor)
  const [myShiftOpen, setMyShiftOpen] = useState(false)
  const [guestsValue, setGuestsValue] = useState(2)
  const [guestsTarget, setGuestsTarget] = useState<GuestsTarget>(null)

  // Order being transferred (passed to TableSelect → starts at destination step).
  const [transferOrderId, setTransferOrderId] = useState<number | null>(null)

  // Round5 Seat Party: the free tables picked on the floor, awaiting the
  // guests dialog before entering order mode.
  const [pendingSeatTables, setPendingSeatTables] = useState<RestaurantTable[] | null>(null)
  // Round5: the full seating list backing this order screen (merged seating
  // from the beginning). null/[single] = a regular single-table order.
  const [seatingTables, setSeatingTables] = useState<{ id: number; name: string }[] | null>(null)

  const [payOpen, setPayOpen] = useState(false)
  const [payOrder, setPayOrder] = useState<Order | null>(null)
  const [checkOpen, setCheckOpen] = useState(false)
  const [checkOrder, setCheckOrder] = useState<Order | null>(null)
  const [receiptOrder, setReceiptOrder] = useState<Order | null>(null)
  const [cancelOpen, setCancelOpen] = useState(false)

  // R8: product tapped on the grid that has option groups — the modifier
  // sheet opens instead of an instant add (plain products add directly).
  const [sheetProduct, setSheetProduct] = useState<Product | null>(null)

  // R11: order-type context of this screen — 'dinein' (table-bound),
  // 'takeaway' or 'delivery' (both table-less). Kept in a ref only: every
  // read is inside event handlers / entry helpers (header text comes from
  // selectedTable.name), so no render ever depends on it.
  const orderKindRef = useRef<OrderKind>('dinein')
  // R11: delivery contact backing a table-less delivery draft (phone is
  // required by the API when the order is created).
  const [deliveryInfo, setDeliveryInfo] = useState<{ phone: string; address: string } | null>(null)

  /** Apply the order-type context (ref + persisted delivery info). */
  const applyKind = useCallback((kind: OrderKind, info: { phone: string; address: string } | null = null) => {
    orderKindRef.current = kind
    const effective = kind === 'delivery' ? info : null
    setDeliveryInfo(effective)
    persistDeliveryInfo(effective)
  }, [])

  // ── Round 7: history-aware navigation (browser/OS back button) ────
  // Unsent drafts stashed per context (table:N / takeaway) so going back
  // never loses items that were never sent to the kitchen.
  const draftStashRef = useRef<Map<string, DraftItem[]>>(new Map())
  // Sub-hash of the screen the state currently shows ('order/5', 'table/7',
  // 'takeaway'; null = floor). Set SYNCHRONOUSLY by the entry helpers so the
  // onNav idempotency checks hold even before React re-renders — a single
  // back press can fire both popstate and hashchange.
  const appliedNavRef = useRef<string | null>(null)
  // True only while a restore applies state through an entry helper: navPush()
  // stays silent then, so popstate-driven restores never add duplicate
  // history entries (otherwise Back would bounce forward).
  const suppressNavPushRef = useRef(false)
  // In-flight restore target + epoch: rejects duplicate restores (the
  // popstate/hashchange double fire) and aborts stale ones when the user
  // navigates again mid-flight.
  const navInFlightRef = useRef<string | null>(null)
  const navEpochRef = useRef(0)
  // Latest onNav handler (single subscription, always-fresh state).
  const navHandlerRef = useRef<(nav: NavHash | null) => void>(() => {})
  // Previous `active` value — detects the hidden → visible flip used to
  // re-assert the deep hash after page.tsx pushed a shallow '#/pos'.
  const prevActiveRef = useRef(active)

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
  // R13 PWA: the sellable catalog is mirrored to localStorage so an offline
  // terminal (or a reload while offline) still shows the menu — the query
  // refetches normally whenever the network is back. Slightly-stale menu
  // offline is the honest trade-off vs. a blank grid.
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
    enabled: mode === 'order',
    staleTime: 15000,
    placeholderData: readProductsCache(),
  })
  const productsData = productsQuery.data
  const products = productsData?.products ?? []

  // ── Newly-ready items → toast (once) ─────────────────────────────
  // PosView stays mounted while another view is active (page.tsx keeps it
  // hidden), so only toast while the POS is actually on screen — the ref
  // still tracks readiness so nothing double-fires on return.
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
      if (newlyReady.length > 0 && active) {
        toast.success(
          t('pos.readyToast', {
            n: newlyReady.length,
            table: selectedTable?.name ?? t('pos.order'),
          }),
        )
      }
    }
    readyRef.current = readyIds
  }, [order, selectedTable?.name, t, active])

  // ── Helpers ──────────────────────────────────────────────────────
  const clampGuests = useCallback(
    (raw: number) => {
      const n = Math.round(Number.isFinite(raw) ? raw : 2)
      return Math.min(MAX_GUESTS, Math.max(MIN_GUESTS, n))
    },
    [],
  )

  // ── Round 7: nav + draft-stash helpers ───────────────────────────

  /** pushNav wrapper — silent while a restore applies state (restores must
   *  not create history entries); a user-initiated push supersedes any
   *  in-flight restore (aborts it via the epoch). */
  const navPush = (view: string, sub?: string | null) => {
    if (suppressNavPushRef.current) return
    if (navInFlightRef.current != null) navEpochRef.current += 1
    pushNav(view, sub)
  }

  /** Stash key for a draft context (per-table, takeaway or delivery). */
  const draftStashKey = (table: { id: number | null } | null) =>
    table?.id != null ? `table:${table.id}` : orderKindRef.current === 'delivery' ? 'delivery' : 'takeaway'

  /** Stash the unsent draft of the current context before leaving it. */
  const stashDraft = () => {
    if (draft.length > 0) {
      draftStashRef.current.set(draftStashKey(selectedTable), draft)
    }
  }

  /** Pop a stashed draft for `key`: restored (with a toast) when non-empty;
   *  the entry is removed either way so stashes never leak. */
  const restoreStash = (key: string, label: string) => {
    const stashed = draftStashRef.current.get(key)
    draftStashRef.current.delete(key)
    if (stashed?.length) {
      setDraft(stashed)
      toast.success(t('pos.draftRestoredToast', { table: label }))
    }
  }

  /** Run a state-applying entry helper with nav pushes suppressed. */
  const withNavSuppression = (fn: () => void) => {
    suppressNavPushRef.current = true
    try {
      fn()
    } finally {
      suppressNavPushRef.current = false
    }
  }

  /** Leave order mode for the floor: stash any unsent draft, full state
   *  reset, then rewrite the current history entry to '#/pos' (replace, never
   *  push — the in-app back button must not spam history). Every exit path
   *  goes through here, so the browser back button and the in-app button
   *  land the user on the floor with the same draft preservation. */
  const resetToTables = () => {
    stashDraft()
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
    setSheetProduct(null)
    setPendingSeatTables(null)
    setSeatingTables(null)
    readyRef.current = null
    appliedNavRef.current = null
    replaceNav('pos')
  }

  const invalidateShared = useCallback(
    async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['orders'] }),
        queryClient.invalidateQueries({ queryKey: ['orders', 'deferred'] }),
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
    setSeatingTables([{ id: table.id, name: table.name }])
    applyKind('dinein')
    readyRef.current = null
    if (table.openOrderId) {
      setActiveOrderId(table.openOrderId)
    } else {
      setActiveOrderId(null)
    }
    appliedNavRef.current = table.openOrderId ? `order/${table.openOrderId}` : `table/${table.id}`
    // Entering an order screen adds a history entry (occupied → live order
    // hash, free → table draft hash); silent during popstate restores.
    navPush('pos', table.openOrderId ? `order/${table.openOrderId}` : `table/${table.id}`)
    // Re-entering a table pops its stashed unsent draft — occupied or free:
    // a waiter may have backed out of this table with items not yet sent.
    restoreStash(`table:${table.id}`, table.name)
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
    setSeatingTables(null) // no tables — tableIds stays unset
    applyKind('takeaway') // R11: orderType 'takeaway' on creation
    readyRef.current = null
    appliedNavRef.current = 'takeaway'
    navPush('pos', 'takeaway')
    restoreStash('takeaway', t('common.takeaway'))
  }

  /** R11: enter order mode for a table-less DELIVERY draft — exactly like
   *  takeaway, but the header reads 'Delivery · {phone}' and the eventual
   *  order-creation body carries orderType 'delivery' + the contact. */
  const startDelivery = (phone: string, address: string) => {
    setSelectedTable({ id: null, name: `${t('pos.delivery')} · ${phone}` })
    setMode('order')
    setDraft([])
    setActiveOrderId(null)
    setTransferOrderId(null)
    setGuestsDraft(1) // one delivery customer — no guests dialog
    setSeatingTables(null) // no tables — delivery MUST NOT carry a tableId
    applyKind('delivery', { phone, address })
    readyRef.current = null
    appliedNavRef.current = 'delivery'
    navPush('pos', 'delivery')
    restoreStash('delivery', t('pos.delivery'))
  }

  /** Open a table-less order (takeaway OR delivery) from the floor chips. */
  const openTablelessOrder = (o: Order) => {
    const isDelivery = o.orderType === 'delivery'
    setSelectedTable({
      id: null,
      name: isDelivery
        ? `${t('pos.delivery')} · ${o.deliveryPhone ?? ''}`
        : t('common.takeaway'),
    })
    setMode('order')
    setDraft([])
    setTransferOrderId(null)
    setGuestsDraft(o.guests ?? 1)
    setSeatingTables(null) // no tables — tableIds stays unset
    applyKind(
      isDelivery ? 'delivery' : 'takeaway',
      isDelivery ? { phone: o.deliveryPhone ?? '', address: o.deliveryAddress ?? '' } : null,
    )
    readyRef.current = null
    queryClient.setQueryData(['pos-order', o.id], { order: o })
    setActiveOrderId(o.id)
    appliedNavRef.current = `order/${o.id}`
    navPush('pos', `order/${o.id}`)
  }

  // ── Seat Party (merged seating from the beginning) ────────────────
  // TableSelect hands over the selected free tables → ask for the guest
  // count (seeded to the total capacity), then enter order mode with the
  // full seating list. The first table is the primary table.
  const handleSeatParty = (tables: RestaurantTable[]) => {
    if (tables.length === 0) return
    setPendingSeatTables(tables)
    const totalSeats = tables.reduce((sum, tb) => sum + (tb.capacity ?? 0), 0)
    setGuestsValue(clampGuests(totalSeats))
    setGuestsTarget({ kind: 'seat-party' })
    setGuestsDialogOpen(true)
  }

  // ── Guests dialog handlers ───────────────────────────────────────
  const cancelGuestsDialog = () => {
    if (guestsTarget?.kind === 'seat-party') setPendingSeatTables(null)
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
    } else if (guestsTarget?.kind === 'seat-party') {
      const seatTables = pendingSeatTables ?? []
      const primary = seatTables[0]
      if (primary) {
        // Enter order mode on the primary table, then widen the seating list
        // to the full party selection (batched setStates — last write wins).
        applySelectTable(primary, value)
        setSeatingTables(seatTables.map((tb) => ({ id: tb.id, name: tb.name })))
      }
      setPendingSeatTables(null)
    } else if (guestsTarget?.kind === 'draft') {
      setGuestsDraft(value)
    } else if (guestsTarget?.kind === 'order' && order) {
      updateGuests.mutate({ id: order.id, guests: value })
    }
    setGuestsDialogOpen(false)
    setGuestsTarget(null)
  }

  /** Append (or merge into) a draft line. Merging happens ONLY when the
   *  product + course match, the line has no notes AND the modifier
   *  signature is identical (same option ids in the same order) — otherwise
   *  the optioned/commented item becomes its own line. `price` stays the
   *  BASE product price; `modifiers` carries the deltas (see lineUnitPrice). */
  const appendDraftLine = (
    p: Product,
    quantity: number,
    modifiers?: SelectedModifier[],
    notes?: string,
  ) => {
    const sig = modifierSignature(modifiers)
    const trimmedNotes = notes?.trim() ?? ''
    setDraft((prev) => {
      const course = guessCourse(p)
      // R11: a special-request comment forces its own row (merge rule)
      const existing =
        trimmedNotes === ''
          ? prev.find(
              (d) =>
                d.productId === p.id &&
                !d.notes &&
                d.course === course &&
                modifierSignature(d.modifiers) === sig,
            )
          : undefined
      if (existing) {
        return prev.map((d) =>
          d.key === existing.key ? { ...d, quantity: round2(d.quantity + quantity) } : d,
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
          quantity,
          notes: trimmedNotes,
          course,
          modifiers,
        },
      ]
    })
  }

  const addProduct = (p: Product) => {
    // Products with (active) option groups open the customize sheet; the
    // rest keep the classic one-tap add.
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

  const draftToPayload = (d: DraftItem[]) =>
    d.map((d) => ({
      productId: d.productId,
      quantity: d.quantity,
      notes: d.notes.trim() || undefined,
      course: d.course,
      selectedModifiers: d.modifiers?.length ? d.modifiers : undefined,
    }))

  const sendToKitchen = async (): Promise<Order | null> => {
    if (draft.length === 0 || sending) return order
    setSending(true)
    try {
      let result: { order: Order }
      // R13 PWA: offline path — queue the creation and finish locally.
      // The draft is cleared (same as online) so a replay cannot duplicate
      // an order the waiter still sees; the banner shows the queued count.
      const payloadBase = {
        items: draftToPayload(draft),
        guests: clampGuests(guestsDraft),
        ...(draftCustomer != null ? { customerId: draftCustomer.id } : {}),
      }
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
        setDraftCustomer(null)
        toast.info(t('offline.bannerSingle'))
        // leave order mode — the floor view shows the queued state via banner
        setMode('tables')
        setSelectedTable(null)
        return null
      }
      // Multi-table seating (Seat Party): create the order spanning ALL the
      // selected tables (tableIds — primary first). Single-table, takeaway
      // and delivery paths keep the classic tableId payload (null = absent).
      const seatingList = seatingTables ?? null
      const multiSeating = (seatingList?.length ?? 0) > 1
      // R11: explicit order type — dinein (table paths), takeaway or delivery
      // (table-less). Delivery additionally carries the customer contact.
      const kind = orderKindRef.current
      if (!order && multiSeating && seatingList) {
        result = await apiFetch<{ order: Order }>('/api/orders', {
          method: 'POST',
          body: {
            tableIds: seatingList.map((tb) => tb.id),
            ...payloadBase,
            orderType: 'dinein',
          },
        })
      } else if (!order) {
        const tableless = selectedTable?.id == null
        const delivery = tableless && kind === 'delivery' && deliveryInfo
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
      setDraftCustomer(null)
      queryClient.setQueryData(['pos-order', result.order.id], { order: result.order })
      setActiveOrderId(result.order.id)
      await invalidateShared()
      toast.success(
        multiSeating && !order && seatingList
          ? t('pos.seatedToast', { n: seatingList.length })
          : t('pos.orderSentToast'),
      )
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
      stashDraft() // normally empty — the draft was flushed by sendToKitchen
      setReceiptOrder(updated)
      setMode('tables')
      setSelectedTable(null)
      setActiveOrderId(null)
      setDraft([])
      setGuestsDraft(2)
      setPendingSeatTables(null)
      setSeatingTables(null)
      readyRef.current = null
      appliedNavRef.current = null
      replaceNav('pos') // paid check → floor entry, no extra history
      await invalidateShared()
    } else {
      queryClient.setQueryData(['pos-order', updated.id], { order: updated })
      // R13: keep the OPEN payment modal in sync — loyalty redemptions stay
      // in-modal (partial tender), so the order prop must refresh with the
      // new paid/remaining/points values.
      setPayOrder(updated)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['orders'] }),
        queryClient.invalidateQueries({ queryKey: ['orders', 'deferred'] }),
        queryClient.invalidateQueries({ queryKey: ['floorplans'] }),
      ])
    }
  }

  // Transfer clicked on the order screen → go to the floor screen with the
  // order preselected (destination step). TableSelect reports completion.
  const startTransfer = () => {
    if (!order) return
    stashDraft() // never lose unsent items while detouring through the floor
    setTransferOrderId(order.id)
    setMode('tables')
    setSelectedTable(null)
    setActiveOrderId(null)
    setDraft([])
    setGuestsDraft(2)
    setPendingSeatTables(null)
    setSeatingTables(null)
    readyRef.current = null
    appliedNavRef.current = null // transfer destination step lives on the floor
    replaceNav('pos') // replace, never push — no history spam
  }

  const handleTransferDone = () => {
    setTransferOrderId(null)
    resetToTables()
  }

  // ── Deferred checks ─────────────────────────────────────────────
  // Chip clicked on the floor → settle the outstanding deferred check via
  // the payment modal (rendered in tables mode too; the modal hides its own
  // defer button for already-deferred orders).
  const handleSettleDeferred = (deferredOrder: Order) => {
    setPayOrder(deferredOrder)
    setPayOpen(true)
  }

  // Defer completed inside the payment modal (modal closes itself + fires
  // the toast) → reset the order screen and refresh everything.
  const handleOrderDeferred = async (_deferredOrder: Order) => {
    resetToTables()
    await invalidateShared()
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

  // Merged-seating badge: extra tables joined to this order (live order field
  // wins once the order exists; draft mode falls back to the seating list).
  const mergedExtraCount = order
    ? (order.extraTableIds?.length ?? 0)
    : Math.max(0, (seatingTables?.length ?? 1) - 1)

  // ── Round 7: popstate-driven restores (browser/OS back & forward) ──

  /** Enter order mode for a live order — mirrors openTablelessOrder /
   *  applySelectTable semantics. Hash-driven, so it never pushes history. */
  const restoreLiveOrder = (restored: Order) => {
    const isDelivery = !restored.table && restored.orderType === 'delivery'
    setSelectedTable(
      restored.table
        ? { id: restored.table.id, name: restored.table.name }
        : isDelivery
          ? { id: null, name: `${t('pos.delivery')} · ${restored.deliveryPhone ?? ''}` }
          : { id: null, name: t('common.takeaway') },
    )
    setMode('order')
    setDraft([])
    setTransferOrderId(null)
    setGuestsDraft(clampGuests(restored.guests ?? 1))
    setSeatingTables(restored.table ? [{ id: restored.table.id, name: restored.table.name }] : null)
    applyKind(
      restored.table ? 'dinein' : isDelivery ? 'delivery' : 'takeaway',
      isDelivery ? { phone: restored.deliveryPhone ?? '', address: restored.deliveryAddress ?? '' } : null,
    )
    readyRef.current = null
    appliedNavRef.current = `order/${restored.id}`
    queryClient.setQueryData(['pos-order', restored.id], { order: restored })
    setActiveOrderId(restored.id)
    toast.success(t('pos.orderRestoredToast', { order: restored.id }))
  }

  /** Claim the right to run a deep restore for `target`. Returns the epoch, or
   *  null when the identical restore is already in flight (popstate +
   *  hashchange double fire). A different target supersedes the old one. */
  const claimNavRestore = (target: string): number | null => {
    if (navInFlightRef.current === target) return null
    navInFlightRef.current = target
    navEpochRef.current += 1
    return navEpochRef.current
  }

  /** Release the restore guards — only the owning epoch may clear them. */
  const releaseNavRestore = (epoch: number) => {
    if (epoch !== navEpochRef.current) return
    navInFlightRef.current = null
  }

  /** True when the hash still points at `target` (mid-flight re-check). */
  const hashStill = (target: string) => {
    const now = currentNav()
    return now != null && now.view === 'pos' && now.sub === target
  }

  /** Failed restore → toast + a safe floor entry. */
  const cannotReopen = () => {
    toast.error(t('pos.cannotReopenToast'))
    replaceNav('pos')
    resetToTables()
  }

  /** Fetch an order imperatively (null on error). */
  const fetchOrderOrNull = async (id: number): Promise<Order | null> => {
    try {
      const data = await fetcher<{ order: Order }>(`/api/orders/${id}`)
      return data.order ?? null
    } catch {
      return null
    }
  }

  /** Restore the live-order screen for '#/pos/order/{id}'. */
  const restoreOrderById = async (id: number, target: string) => {
    const epoch = claimNavRestore(target)
    if (epoch == null) return
    stashDraft() // leaving the current context — never lose unsent items
    try {
      const fetched = await fetchOrderOrNull(id)
      // The user navigated again mid-flight → abort silently.
      if (epoch !== navEpochRef.current || !hashStill(target)) return
      if (fetched && fetched.status === 'open') {
        restoreLiveOrder(fetched)
      } else {
        cannotReopen() // closed / cancelled / merged away / fetch error
      }
    } finally {
      releaseNavRestore(epoch)
    }
  }

  /** Restore the screen for '#/pos/table/{id}': its live order when the table
   *  got occupied meanwhile (hash fixed to order/{id}), or the free-table
   *  draft screen — applySelectTable pops any stashed draft for it. */
  const restoreTableById = async (id: number, target: string) => {
    const epoch = claimNavRestore(target)
    if (epoch == null) return
    stashDraft()
    try {
      // Same data source as the floor screen (TableSelect's floorplans query).
      const data = await fetcher<{ floorPlans: FloorPlan[] }>('/api/floorplans')
      if (epoch !== navEpochRef.current || !hashStill(target)) return
      queryClient.setQueryData(['floorplans'], data)
      const table =
        data.floorPlans.flatMap((fp) => fp.tables).find((tb) => tb.id === id) ?? null
      if (!table) {
        cannotReopen()
        return
      }
      if (table.openOrderId != null) {
        // Occupied meanwhile → its live order screen; fix the hash to it.
        const orderTarget = `order/${table.openOrderId}`
        replaceNav('pos', orderTarget)
        const fetched = await fetchOrderOrNull(table.openOrderId)
        if (epoch !== navEpochRef.current || !hashStill(orderTarget)) return
        if (fetched && fetched.status === 'open') restoreLiveOrder(fetched)
        else cannotReopen()
        return
      }
      // Free table → draft mode (restores are push-suppressed inside).
      withNavSuppression(() => applySelectTable(table, 2))
    } catch {
      // Floorplans fetch failed — only bail to the floor when the hash still
      // points at this target (never clobber another view's hash).
      if (epoch === navEpochRef.current && hashStill(target)) cannotReopen()
    } finally {
      releaseNavRestore(epoch)
    }
  }

  /** onNav handler — browser back/forward + hand-edited hashes. Idempotent:
   *  navigating to the state we are already in is a no-op (checked against
   *  both the rendered state and the synchronous appliedNavRef mirror). */
  const handleNavEvent = (nav: NavHash | null) => {
    if (nav == null || nav.view !== 'pos') return // another view owns the hash
    const sub = nav.sub
    if (sub == null) {
      // Floor — leave order mode exactly like the in-app back button
      // (stash + reset + replaceNav('#/pos'), itself idempotent here).
      if (mode === 'order' || appliedNavRef.current != null) resetToTables()
      return
    }
    if (sub.startsWith('order/')) {
      const id = Number.parseInt(sub.slice('order/'.length), 10)
      if (!Number.isInteger(id) || id <= 0) return
      if (appliedNavRef.current === sub) return // idempotent re-entry
      if (mode === 'order' && activeOrderId === id) return
      void restoreOrderById(id, sub)
      return
    }
    if (sub.startsWith('table/')) {
      const id = Number.parseInt(sub.slice('table/'.length), 10)
      if (!Number.isInteger(id) || id <= 0) return
      if (appliedNavRef.current === sub) return
      if (mode === 'order' && selectedTable?.id === id && activeOrderId == null) return
      void restoreTableById(id, sub)
      return
    }
    if (sub === 'takeaway') {
      if (appliedNavRef.current === sub) return
      if (mode === 'order' && selectedTable?.id == null && activeOrderId == null && orderKindRef.current !== 'delivery') return
      const epoch = claimNavRestore(sub)
      if (epoch == null) return
      try {
        stashDraft()
        // startTakeaway semantics with pushes suppressed; pops the
        // 'takeaway' stash (toast when items come back).
        withNavSuppression(() => startTakeaway())
      } finally {
        releaseNavRestore(epoch)
      }
    }
    if (sub === 'delivery') {
      if (appliedNavRef.current === sub) return
      if (mode === 'order' && selectedTable?.id == null && activeOrderId == null && orderKindRef.current === 'delivery') return
      const epoch = claimNavRestore(sub)
      if (epoch == null) return
      try {
        stashDraft()
        // The delivery contact lives in state (view switches) or in
        // sessionStorage (full reload) — without it the screen cannot be
        // rebuilt, so fall back to the floor with the standard toast.
        const info = deliveryInfo ?? readDeliveryInfo()
        if (!info) {
          cannotReopen()
          return
        }
        withNavSuppression(() => startDelivery(info.phone, info.address))
      } finally {
        releaseNavRestore(epoch)
      }
    }
  }

  // Always dispatch nav events to the handler of the LATEST render (single
  // subscription created below, no stale closures).
  useEffect(() => {
    navHandlerRef.current = handleNavEvent
  })

  // Single subscription for the component's lifetime (idempotent handler).
  useEffect(() => {
    const unsubscribe = onNav((nav) => navHandlerRef.current(nav))
    return unsubscribe
  }, [])

  // Mount-time deep-link restore: refresh/bookmark on '#/pos/order/N',
  // '#/pos/table/N' or '#/pos/takeaway' reopens that screen (pushes are
  // suppressed — the hash already points here). Floor is the default state.
  useEffect(() => {
    const nav = currentNav()
    if (nav && nav.view === 'pos' && nav.sub) navHandlerRef.current(nav)
  }, [])

  // Re-assert the deep hash when this view becomes active again: page.tsx
  // pushes a shallow '#/pos' when returning from another view, and this
  // replaces it with the real deep hash of the preserved order screen.
  useEffect(() => {
    const wasActive = prevActiveRef.current
    prevActiveRef.current = active
    // Fire only on the hidden → visible flip (wasActive false, now true)
    // while an order screen is preserved.
    if (wasActive || !active || mode !== 'order') return
    const sub = activeOrderId
      ? `order/${activeOrderId}`
      : selectedTable?.id != null
        ? `table/${selectedTable.id}`
        : orderKindRef.current === 'delivery'
          ? 'delivery'
          : 'takeaway'
    replaceNav('pos', sub)
  }, [active, mode, activeOrderId, selectedTable?.id])

  // ── Render ───────────────────────────────────────────────────────
  if (mode === 'tables') {
    return (
      <>
        <TableSelect
          onSelectTable={selectTable}
          onTakeaway={startTakeaway}
          onDelivery={startDelivery}
          onOpenTablelessOrder={openTablelessOrder}
          transferOrderId={transferOrderId}
          onTransferDone={handleTransferDone}
          onSeatParty={handleSeatParty}
          onSettleDeferred={handleSettleDeferred}
          onMyShift={() => setMyShiftOpen(true)}
        />
        {/* R8: per-server shift closeout — sales, tips & payment mix today */}
        <MyShiftSheet open={myShiftOpen} onOpenChange={setMyShiftOpen} />
        {/* Guests quick dialog — shown BEFORE entering order mode on a free
            table (or after a Seat Party selection). */}
        <GuestsDialog
          open={guestsDialogOpen}
          value={guestsValue}
          pending={updateGuests.isPending}
          onValueChange={setGuestsValue}
          onConfirm={confirmGuests}
          onCancel={cancelGuestsDialog}
        />
        {/* Deferred-check settlement (chips on the floor) — same payment modal
            as order mode; hides its defer button for already-deferred orders. */}
        {payOrder && (
          <PaymentModal
            order={payOrder}
            open={payOpen}
            onOpenChange={(o) => {
              setPayOpen(o)
              if (!o) setPayOrder(null)
            }}
            onSuccess={(updated, closed) => void handlePaySuccess(updated, closed)}
            onDeferred={(deferredOrder) => void handleOrderDeferred(deferredOrder)}
          />
        )}
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
          {mergedExtraCount > 0 && (
            <Badge className="gap-1 border-violet-300 bg-violet-100 text-violet-800 hover:bg-violet-100">
              <Combine className="size-3" aria-hidden />
              {t('pos.mergedTablesBadge', { n: mergedExtraCount })}
            </Badge>
          )}
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
            draftCustomer={draftCustomer}
            onDraftCustomerChange={setDraftCustomer}
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

      {/* ── R8: item options (customize) sheet — keyed by product so every
          open starts with a clean selection state ── */}
      <ModifierSheet
        key={sheetProduct?.id ?? 'closed'}
        open={!!sheetProduct}
        product={sheetProduct}
        onOpenChange={(o) => {
          if (!o) setSheetProduct(null)
        }}
        onConfirm={handleSheetConfirm}
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
          onDeferred={(deferredOrder) => void handleOrderDeferred(deferredOrder)}
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
