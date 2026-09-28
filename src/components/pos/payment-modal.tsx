'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  AlertCircle,
  Banknote,
  Check,
  ChevronLeft,
  ChevronRight,
  Coins,
  CreditCard,
  HandCoins,
  Hourglass,
  Loader2,
  Minus,
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
import { PAYMENT_METHODS, TIP_PRESETS } from '@/lib/constants'
import { formatCurrency, formatQty } from '@/lib/format'
import { localizedName, useI18n } from '@/lib/i18n'
import { normalizePersonName } from '@/lib/names'
import { breakdownChange, denomLabel, quickTenderChips } from '@/lib/payment'
import { cn } from '@/lib/utils'
import type { Order } from '@/lib/types'
import CheckModal, { type CheckSplitRow } from './check-modal'
import { newDraftKey, parseAmount, round2 } from './pos-utils'

type PaymentModalProps = {
  order: Order
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: (order: Order, closed: boolean) => void
  /** Called after the check is deferred (pay later, client name recorded).
   *  The modal closes itself; the parent resets its order screen state. */
  onDeferred?: (order: Order) => void
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
}

type SubmitRow = { method: string; amount: number }

type SplitTab = 'single' | 'equal' | 'items' | 'custom'

// ── p8: quantity-level item split (pure helpers, shared by the math + UI) ──
// A merged cart line ("5 × Pizza") must be handable out ONE unit per payer.
// Model: per line, an explicit per-payer unit count (steppers). Units not
// explicitly allocated follow the line's BASE payer (the classic whole-line
// assignment — default P1), so an untouched line behaves exactly like before.
// Invariant: Σ explicit ≤ floor(line qty); a fractional remainder (weighed
// items) always follows the base payer.
export function qtyForPayerOf(
  line: { id: number; qty: number },
  payer: number,
  assignments: Record<number, number>,
  qtyAllocations: Record<number, number[]>,
): number {
  const alloc = qtyAllocations[line.id]
  const base = assignments[line.id] ?? 0
  if (alloc == null) return base === payer ? line.qty : 0
  const allocated = alloc.reduce((s, q) => s + q, 0)
  const unallocated = Math.max(0, line.qty - allocated)
  return (alloc[payer] ?? 0) + (base === payer ? unallocated : 0)
}

// ── R13: terminal-local split preferences ──────────────────────────
// Remembers the last-used split mode + payer counts so the next check on
// this terminal starts where the last one left off (shared-table venues
// usually split the same way all night). localStorage, per terminal.
const PAYMENT_PREFS_KEY = 'rms-payment-prefs'
type PaymentPrefs = { tab: SplitTab; eqPayers: number; itPayers: number }

function readPaymentPrefs(): PaymentPrefs | null {
  try {
    const raw = window.localStorage.getItem(PAYMENT_PREFS_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    const p = parsed as Record<string, unknown>
    const tab = ['single', 'equal', 'items', 'custom'].includes(String(p.tab))
      ? (p.tab as SplitTab)
      : 'single'
    const eqPayers = Number(p.eqPayers)
    const itPayers = Number(p.itPayers)
    return {
      tab,
      eqPayers: Number.isInteger(eqPayers) && eqPayers >= 2 && eqPayers <= 12 ? eqPayers : 2,
      itPayers: Number.isInteger(itPayers) && itPayers >= 2 && itPayers <= 6 ? itPayers : 2,
    }
  } catch {
    return null
  }
}

function writePaymentPrefs(prefs: PaymentPrefs): void {
  try {
    window.localStorage.setItem(PAYMENT_PREFS_KEY, JSON.stringify(prefs))
  } catch {
    // storage unavailable — preference lasts for the session only
  }
}

const METHOD_META: Record<string, { labelKey: string; icon: LucideIcon }> = {
  cash: { labelKey: 'status.payment.cash', icon: Banknote },
  card: { labelKey: 'status.payment.card', icon: CreditCard },
  other: { labelKey: 'status.payment.other', icon: MoreHorizontal },
}

export default function PaymentModal({ order, open, onOpenChange, onSuccess, onDeferred }: PaymentModalProps) {
  const { t, lang, isRTL } = useI18n()
  const [tab, setTab] = useState<SplitTab>('single')
  const [submitting, setSubmitting] = useState(false)
  const [checkOpen, setCheckOpen] = useState(false)

  // Defer-payment state (check stays open under the client's name)
  const [deferOpen, setDeferOpen] = useState(false)
  const [deferName, setDeferName] = useState('')
  const [deferSubmitting, setDeferSubmitting] = useState(false)

  // Which payment row the method tiles currently target.
  const [activeIdx, setActiveIdx] = useState(0)

  // R8: tips — gratuity ON TOP of the bill, attached PER PAYMENT ROW
  // (single tab → one tip; equal/items/custom → per-payer tips). Keyed per
  // tab+row so every payer's tip survives row switching; the preset
  // selection and the custom input text are tracked separately per row.
  const [tipSel, setTipSel] = useState<Record<string, number | 'custom'>>({})
  const [tipCustom, setTipCustom] = useState<Record<string, string>>({})

  const [singleRow, setSingleRow] = useState<EditableRow>({ id: 'single', method: 'cash', amount: '' })
  const [customRows, setCustomRows] = useState<EditableRow[]>([])

  const [eqPayers, setEqPayers] = useState(2)
  const [eqMethods, setEqMethods] = useState<Record<number, string>>({})

  const [itPayers, setItPayers] = useState(2)
  const [itMethods, setItMethods] = useState<Record<number, string>>({})
  const [assignments, setAssignments] = useState<Record<number, number>>({})
  // p8: per-line per-payer unit allocation for lines with quantity > 1
  // (itemId → array indexed by payer). See qtyForPayerOf above.
  const [qtyAllocations, setQtyAllocations] = useState<Record<number, number[]>>({})

  // ── R13: loyalty redemption state ──
  const [redeemInput, setRedeemInput] = useState('')
  const [redeeming, setRedeeming] = useState(false)

  // ── R26 Payment Pro: cash tender flow (single tab, cash method) ──
  // The waiter types what the guest HANDED OVER ("Cash received"). The bill
  // portion charged is min(tendered, remaining); the difference becomes
  // either a tip ("keep the change") or change to hand back — with a note
  // & coin breakdown so nobody has to do math at the table.
  const [tender, setTender] = useState('')
  const [overageMode, setOverageMode] = useState<'tip' | 'change'>('change')
  // Success state: after a paid check with change due, the modal transforms
  // into a big "give back EGP X" screen (breakdown included) until Done.
  const [changeDueResult, setChangeDueResult] = useState<{ order: Order; amount: number } | null>(null)
  // R26: scroll the overage choice into view the moment it appears — the
  // waiter MUST see the tip-vs-change decision, never hunt for it.
  const overageRef = useRef<HTMLDivElement | null>(null)
  const lastOverageRef = useRef(0)

  const remaining = round2(Math.max(0, order.remainingAmount))

  // ── R26: single-tab cash tender math ──
  const singleCash = tab === 'single' && singleRow.method === 'cash'
  const tendered = parseAmount(tender)
  const cashCharge = round2(Math.min(tendered, remaining))
  const tenderDiff = round2(tendered - remaining)
  const overage = tenderDiff > 0.01 ? tenderDiff : 0
  const tipFromChange = singleCash && overage > 0 && overageMode === 'tip' ? overage : 0
  const changeFromTender = singleCash && overage > 0 && overageMode === 'change' ? overage : 0

  // R26: overage appeared (0 → >0)? Bring the choice panel into view.
  useEffect(() => {
    if (overage > 0 && lastOverageRef.current === 0 && open) {
      overageRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
    lastOverageRef.current = overage
  }, [overage, open])

  // Reset state whenever the modal opens for (a new) order.
  // R13: keyed to [open, order.id] only — the previous remainingAmount dep
  // wiped the split config mid-dialog whenever a loyalty redemption or a
  // co-worker's partial payment refreshed the order prop.
  useEffect(() => {
    if (!open) return
    const rem = round2(Math.max(0, order.remainingAmount))
    // R13: restore the terminal's last-used split configuration
    const prefs = readPaymentPrefs()
    setTab(prefs?.tab ?? 'single')
    setSingleRow({ id: 'single', method: 'cash', amount: String(rem) })
    setCustomRows([{ id: newDraftKey(), method: 'cash', amount: String(rem) }])
    setEqPayers(prefs?.eqPayers ?? 2)
    setEqMethods({})
    setItPayers(prefs?.itPayers ?? 2)
    setItMethods({})
    setAssignments({})
    setQtyAllocations({})
    setSubmitting(false)
    setActiveIdx(0)
    setTipSel({})
    setTipCustom({})
    setCheckOpen(false)
    setDeferOpen(false)
    setDeferName('')
    setDeferSubmitting(false)
    setRedeemInput('')
    setRedeeming(false)
    // R26: tender starts at the exact remaining; change is the safe default
    setTender(String(rem))
    setOverageMode('change')
    setChangeDueResult(null)
     
  }, [open, order.id])

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
        qty: it.quantity,
        unitPrice: round2(it.unitPrice),
        name: it.product ? localizedName(it.product.name, it.product.nameAr, lang) : t('pos.item'),
        nameAr: it.product?.nameAr?.trim() || null,
        label: `${formatQty(it.quantity)} × ${
          it.product ? localizedName(it.product.name, it.product.nameAr, lang) : t('pos.item')
        }`,
        total: round2(it.quantity * it.unitPrice),
      })),
    [order.items, t, lang],
  )

  const itAmounts = useMemo(() => {
    const subtotal = round2(order.subtotalAmount)
    const rawTotals = new Array<number>(itPayers).fill(0)
    for (const line of itemLines) {
      for (let p = 0; p < itPayers; p++) {
        // p8: quantity-level allocation — each payer's raw share is their
        // units × unit price (untouched lines: whole line to its payer).
        const units = qtyForPayerOf(line, p, assignments, qtyAllocations)
        if (units > 0) rawTotals[p] = round2(rawTotals[p] + units * line.unitPrice)
      }
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
  }, [itemLines, assignments, qtyAllocations, itPayers, remaining, order.subtotalAmount])

  // ── p8: quantity-allocation mutators ───────────────────────────────
  /** Normalized allocation array for a line (padded to the payer count). */
  const allocArray = (lineId: number): number[] => {
    const cur = qtyAllocations[lineId] ?? []
    const arr = cur.slice(0, itPayers)
    while (arr.length < itPayers) arr.push(0)
    return arr
  }

  const allocatedWholeUnits = (lineId: number, arr?: number[]): number =>
    (arr ?? allocArray(lineId)).reduce((s, q) => s + q, 0)

  /** Stepper + on a payer: take a unit from the free pool, or transfer one
   *  from the base payer's explicit units when the pool is empty. */
  const addUnitTo = (line: { id: number; qty: number }, payer: number) => {
    setQtyAllocations((prev) => {
      const arr = (() => {
        const cur = prev[line.id] ?? []
        const a = cur.slice(0, itPayers)
        while (a.length < itPayers) a.push(0)
        return a
      })()
      const whole = Math.floor(line.qty)
      const allocated = arr.reduce((s, q) => s + q, 0)
      const base = Math.min(assignments[line.id] ?? 0, itPayers - 1)
      if (allocated < whole) {
        arr[payer] += 1
      } else if (arr[base] > 0 && payer !== base) {
        arr[base] -= 1
        arr[payer] += 1
      }
      return { ...prev, [line.id]: arr }
    })
  }

  /** Stepper − on a payer: release an explicitly steered unit back to the
   *  pool (it follows the base payer again). */
  const removeUnitFrom = (lineId: number, payer: number) => {
    setQtyAllocations((prev) => {
      const cur = prev[lineId]
      if (!cur || (cur[payer] ?? 0) <= 0) return prev
      const arr = cur.slice(0, itPayers)
      while (arr.length < itPayers) arr.push(0)
      arr[payer] = Math.max(0, (arr[payer] ?? 0) - 1)
      return { ...prev, [lineId]: arr }
    })
  }

  /** "1 each": spread the line's whole units round-robin across the payers
   *  (5 pizzas across 5 payers → 1 each — the classic shared-table case). */
  const spreadEvenly = (lineId: number, lineQty: number) => {
    setQtyAllocations((prev) => {
      const arr = new Array<number>(itPayers).fill(0)
      let left = Math.floor(lineQty)
      let i = 0
      while (left > 0) {
        arr[i % itPayers] += 1
        left -= 1
        i += 1
      }
      return { ...prev, [lineId]: arr }
    })
  }

  const submitRows: SubmitRow[] = useMemo(() => {
    if (tab === 'single') {
      // R26: cash single charges min(tendered, remaining) — never over the bill
      const row = toSubmitRow(singleRow)
      return [singleCash ? { method: row.method, amount: cashCharge } : row]
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

  // ── Active row / method tiles ─────────────────────────────────────
  const rowCount =
    tab === 'single' ? 1 : tab === 'equal' ? eqPayers : tab === 'items' ? itPayers : customRows.length
  const safeActiveIdx = Math.min(activeIdx, Math.max(0, rowCount - 1))

  // ── Tips (R8) ────────────────────────────────────────────────
  // Tips sit ON TOP of the bill: `remaining` stays bill-only and the
  // validation below is unchanged (Σ row amounts ≤ remaining as before).

  /** Stable per-row key for the tip state ('single' | 'eq:0' | 'it:1' | 'c:<rowId>'). */
  const tipKeyFor = (index: number): string => {
    if (tab === 'single') return 'single'
    if (tab === 'equal') return `eq:${index}`
    if (tab === 'items') return `it:${index}`
    return `c:${customRows[index]?.id ?? index}`
  }

  const activeTipKey = tipKeyFor(safeActiveIdx)
  const activeSel = tipSel[activeTipKey]
  const activeCustomText = tipCustom[activeTipKey] ?? ''

  const activeRowAmount = useMemo(
    () => round2(submitRows[safeActiveIdx]?.amount ?? 0),
    [submitRows, safeActiveIdx],
  )

  /** Tip for a submit-row index: {value, invalid} — presets are % of that row's amount.
   *  R26: the single-tab "add to tip" overage lands on top of any preset. */
  const rowTip = (index: number): { value: number; invalid: boolean } => {
    const key = tipKeyFor(index)
    const sel = tipSel[key]
    let value = 0
    let invalid = false
    if (sel != null && sel !== 0) {
      if (sel === 'custom') {
        const parsed = parseTipInput(tipCustom[key] ?? '')
        if (parsed == null) {
          invalid = true
        } else {
          value = parsed
        }
      } else {
        value = round2((submitRows[index]?.amount ?? 0) * (sel / 100))
      }
    }
    if (index === 0 && tipFromChange > 0) value = round2(value + tipFromChange)
    return { value, invalid }
  }

  const activeTip = rowTip(safeActiveIdx)
  const tipsTotal = round2(submitRows.reduce((s, _r, i) => s + rowTip(i).value, 0))
  const tipInvalid = submitRows.some((_r, i) => rowTip(i).invalid)

  const canSubmit =
    !submitting &&
    remaining > 0 &&
    sum > 0 &&
    !exceeds &&
    !tipInvalid &&
    (!singleCash || tendered > 0)

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
    // R13: persist the split-mode choice for this terminal
    writePaymentPrefs({ tab: v as SplitTab, eqPayers, itPayers })
  }

  // ── Guest check rows mirroring the current split configuration ────
  const checkRows: CheckSplitRow[] = useMemo(() => {
    if (tab === 'single') {
      // R26: cash single mirrors the charged portion (≤ remaining)
      const amount = singleCash
        ? cashCharge
        : parseAmount(singleRow.amount) || remaining
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
      // p8: each payer's row carries their ITEMIZED lines (quantity-aware)
      // so the printed split check shows exactly who had what.
      return itAmounts.map((amount, i) => ({
        label: t('pos.payer', { n: i + 1 }),
        amount,
        method: itMethods[i] ?? 'cash',
        items: itemLines.flatMap((line) => {
          const units = qtyForPayerOf(line, i, assignments, qtyAllocations)
          if (units <= 0) return []
          return [
            {
              qty: units,
              name: line.name,
              nameAr: line.nameAr,
              total: round2(units * line.unitPrice),
            },
          ]
        }),
      }))
    }
    return customRows.map((r, i) => ({
      label: t('pos.paymentN', { n: i + 1 }),
      amount: parseAmount(r.amount),
      method: r.method,
    }))
  }, [tab, singleRow, customRows, eqAmounts, eqMethods, eqPayers, itAmounts, itMethods, remaining, itemLines, assignments, qtyAllocations, t])

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
    setCustomRows((rows) => [...rows, { id: newDraftKey(), method: 'cash', amount: String(next) }])
  }

  const handleSubmit = async () => {
    // R8: each payment row carries its own tip (≥ 0, round2) on top of the
    // amount — the API persists it but never counts it toward paidAmount.
    // R26: the single cash row additionally carries what the guest handed
    // over (amountTendered) and the change going back (changeGiven); the
    // auto timestamp+method reference is generated server-side.
    const payments = submitRows
      .map((r, i) => ({ ...r, amount: round2(r.amount), tip: Math.max(0, round2(rowTip(i).value)) }))
      .filter((r) => r.amount > 0)
      .map((r, i) => ({
        method: r.method,
        amount: r.amount,
        tip: r.tip,
        ...(singleCash && i === 0 && tendered > 0 ? { amountTendered: round2(tendered) } : {}),
        ...(singleCash && i === 0 && changeFromTender > 0 ? { changeGiven: round2(changeFromTender) } : {}),
      }))
    if (payments.length === 0) return
    setSubmitting(true)
    try {
      // R13: remember this terminal's split configuration on success
      writePaymentPrefs({ tab, eqPayers, itPayers })
      const result = await apiFetch<PaymentResult>(`/api/orders/${order.id}/payments`, {
        method: 'POST',
        body: { payments },
      })
      if (result.closed) {
        if (changeFromTender > 0) {
          // R26: don't close yet — the waiter still owes the guest change.
          // Big give-back screen first; Done hands over to the receipt.
          toast.success(t('pos.changeGivenToast', { amount: formatCurrency(changeFromTender) }))
          setChangeDueResult({ order: result.order, amount: round2(changeFromTender) })
          return
        }
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

  // R26: closing the dialog (X / esc / backdrop) while the give-back screen
  // is up must still advance the parent — the payment DID land.
  const handleDialogChange = (o: boolean) => {
    if (!o && changeDueResult) {
      const { order: paidOrder } = changeDueResult
      setChangeDueResult(null)
      onSuccess(paidOrder, true)
    }
    onOpenChange(o)
  }

  // ── R13: loyalty redemption (points → tender, capped at remaining) ──
  const customerPoints = order.customer?.points ?? 0
  const loyaltyAvailable =
    order.customer != null && customerPoints > 0 && remaining > 0 && order.status !== 'paid'

  const handleRedeem = async (points: number) => {
    if (redeeming || !Number.isFinite(points) || points <= 0) return
    setRedeeming(true)
    try {
      const result = await apiFetch<PaymentResult>(`/api/orders/${order.id}/payments`, {
        method: 'POST',
        body: { payments: [], redeemPoints: points },
      })
      toast.success(
        t('pos.pointsRedeemedToast', { n: points, egp: formatCurrency(result.paidAmount ?? 0) }),
      )
      setRedeemInput('')
      // refresh amounts to the new remaining (config stays as chosen)
      const newRemaining = round2(Math.max(0, result.remaining))
      setSingleRow((r) => ({ ...r, amount: String(newRemaining) }))
      setCustomRows((rows) =>
        rows.map((r, i) => (i === 0 ? { ...r, amount: String(newRemaining) } : r)),
      )
      // R26: the cash-received input follows the new remaining too
      setTender(String(newRemaining))
      setOverageMode('change')
      onSuccess(result.order, result.closed)
      if (result.closed) onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('pos.paymentFailedToast'))
    } finally {
      setRedeeming(false)
    }
  }

  // ── Defer payment (client pays later, check tracked by name) ──────
  const canDefer = order.status === 'open' && remaining > 0

  const handleDefer = async () => {
    // R13: normalized client-side AND server-side (trim/collapse/Title Case)
    const clientName = normalizePersonName(deferName)
    if (!clientName) {
      toast.error(t('pos.deferredNameRequired'))
      return
    }
    if (deferSubmitting) return
    setDeferSubmitting(true)
    try {
      const result = await apiFetch<{ order: Order }>(`/api/orders/${order.id}/defer`, {
        method: 'POST',
        body: { clientName },
      })
      toast.success(t('pos.deferredToast', { order: order.id, client: clientName }))
      setDeferOpen(false)
      onDeferred?.(result.order)
      onOpenChange(false)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('pos.paymentFailedToast'))
    } finally {
      setDeferSubmitting(false)
    }
  }

  const singleExceeds =
    tab === 'single' && !singleCash && parseAmount(singleRow.amount) > round2(remaining + 0.01)

  return (
    <>
      <Dialog open={open} onOpenChange={handleDialogChange}>
        {changeDueResult ? (
          /* ── R26: give-back screen — the payment landed, the waiter still
           *  owes the guest change. Big amount + note/coin breakdown. */
          <DialogContent className="sm:max-w-sm">
            <DialogHeader className="sr-only">
              <DialogTitle>{t('pos.changeDue')}</DialogTitle>
              <DialogDescription>{t('pos.changeDueSub')}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-amber-500 bg-amber-50 p-6 text-center">
              <span className="grid size-16 place-items-center rounded-full bg-amber-100" aria-hidden>
                <Coins className="size-9 text-amber-600" />
              </span>
              <p className="text-sm font-semibold uppercase tracking-wide text-amber-700">
                {t('pos.changeDue')} · {t('pos.changeDueSub')}
              </p>
              <p className="text-5xl font-black tabular-nums text-amber-700">
                {formatCurrency(changeDueResult.amount)}
              </p>
              <ChangeBreakdown change={changeDueResult.amount} />
            </div>
            <Button
              className="h-14 w-full rounded-xl bg-emerald-600 text-lg font-bold text-white hover:bg-emerald-700"
              onClick={() => {
                const { order: paidOrder } = changeDueResult
                setChangeDueResult(null)
                onSuccess(paidOrder, true)
                onOpenChange(false)
              }}
            >
              <Check className="size-5" /> {t('pos.changeDone')}
            </Button>
          </DialogContent>
        ) : (
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {t('pos.payment')} · {order.table?.name ?? t('common.takeaway')} ·{' '}
              {t('common.order')} #{order.id}
            </DialogTitle>
            <DialogDescription>{t('pos.paymentDesc')}</DialogDescription>
          </DialogHeader>

          {/* Summary */}
          <div className="grid grid-cols-3 gap-2 rounded-xl border border-border bg-white p-3 text-center shadow-sm">
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

          {/* R13: loyalty — customer chip + points redemption. Points become
              tender immediately (a payment row appears in the summary); the
              modal stays open for the remainder. */}
          {order.customer != null && (
            <div className="flex items-center gap-2 rounded-xl border border-primary/25 bg-primary/[0.05] px-3 py-2.5">
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/15 text-base" aria-hidden>
                ⭐
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-primary">
                  {order.customer.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {customerPoints > 0
                    ? t('pos.pointsBalance', { n: round2(customerPoints) })
                    : t('pos.noPoints')}
                  {order.customer.phone ? ` · ${order.customer.phone}` : ''}
                </p>
              </div>
              {loyaltyAvailable && (
                <div className="flex shrink-0 items-center gap-1.5">
                  <Input
                    type="number"
                    min={1}
                    max={Math.floor(customerPoints)}
                    inputMode="numeric"
                    value={redeemInput}
                    onChange={(e) => setRedeemInput(e.target.value)}
                    placeholder={t('pos.redeemPointsPh')}
                    aria-label={t('pos.redeemPoints')}
                    className="h-10 w-24 rounded-lg text-center text-sm tabular-nums"
                    disabled={redeeming}
                  />
                  <Button
                    type="button"
                    size="sm"
                    disabled={
                      redeeming ||
                      !redeemInput.trim() ||
                      Number(redeemInput) <= 0 ||
                      Number(redeemInput) > Math.floor(customerPoints)
                    }
                    onClick={() => void handleRedeem(Number(redeemInput))}
                    className="h-10 rounded-lg bg-primary px-3 text-xs font-semibold text-white hover:bg-primary/90"
                  >
                    {redeeming ? <Loader2 className="size-4 animate-spin" /> : t('pos.redeemPoints')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={redeeming}
                    title={t('pos.redeemAll')}
                    onClick={() => void handleRedeem(Math.floor(customerPoints))}
                    className="h-10 rounded-lg border-primary/40 px-3 text-xs font-semibold text-primary hover:bg-primary/10"
                  >
                    {t('pos.redeemAll')}
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Method tiles — apply to the active row below */}
          <div className="space-y-1.5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('pos.methodAppliesTo')} <span className="text-primary">{activeRowLabel}</span>
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
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-white text-stone-600 hover:border-primary/40',
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
              {singleCash ? (
                /* R26 Payment Pro: cash tender flow — enter what the guest
                 * handed over; overage becomes a tip or change (with a
                 * denomination breakdown). No math, no overpay errors. */
                <div className="space-y-2 rounded-xl border-2 border-primary/30 bg-primary/[0.04] p-3">
                  <label
                    htmlFor="r26-tender"
                    className="flex items-center gap-1.5 text-sm font-semibold text-primary"
                  >
                    <Banknote className="size-4 shrink-0" aria-hidden /> {t('pos.cashReceived')}
                  </label>
                  <Input
                    id="r26-tender"
                    type="number"
                    min={0}
                    step={0.25}
                    inputMode="decimal"
                    value={tender}
                    onChange={(e) => setTender(e.target.value)}
                    aria-label={t('pos.cashReceivedAria')}
                    className="h-14 rounded-xl border-2 border-primary/40 text-right text-2xl font-bold tabular-nums"
                  />
                  {/* Quick chips: exact + smart round-ups guests actually hand over */}
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      aria-pressed={Math.abs(tendered - remaining) <= 0.01}
                      onClick={() => setTender(String(remaining))}
                      className={cn(
                        'h-11 min-w-16 rounded-xl border-2 px-3 text-sm font-bold tabular-nums transition active:scale-95',
                        Math.abs(tendered - remaining) <= 0.01
                          ? 'border-primary bg-primary text-white'
                          : 'border-border bg-white text-stone-600 hover:border-primary/40',
                      )}
                    >
                      {t('pos.tenderExact')} · {formatCurrency(remaining)}
                    </button>
                    {quickTenderChips(remaining).map((chip) => (
                      <button
                        key={chip}
                        type="button"
                        aria-pressed={tendered === chip}
                        onClick={() => setTender(String(chip))}
                        className={cn(
                          'h-11 min-w-16 rounded-xl border-2 px-3 text-sm font-bold tabular-nums transition active:scale-95',
                          tendered === chip
                            ? 'border-primary bg-primary text-white'
                            : 'border-border bg-white text-stone-600 hover:border-primary/40',
                        )}
                      >
                        {formatCurrency(chip)}
                      </button>
                    ))}
                  </div>

                  {/* Partial (cash < remaining) — plain info line */}
                  {tendered > 0 && tendered + 0.01 < remaining && (
                    <p className="rounded-md bg-amber-50 px-3 py-2 text-center text-xs font-medium text-amber-700">
                      {t('pos.tenderPartial')} · {t('pos.charging')}{' '}
                      <span className="font-bold tabular-nums">{formatCurrency(cashCharge)}</span> ·{' '}
                      {t('pos.remainingAfter', {
                        amount: formatCurrency(round2(remaining - cashCharge)),
                      })}
                    </p>
                  )}

                  {/* Overage — the guest paid more than the bill: keep as tip
                      or hand change back. Two big choice cards. */}
                  {overage > 0 && (
                    <div ref={overageRef} className="space-y-2 rounded-xl border border-amber-300 bg-amber-50/70 p-2.5">
                      <p className="text-center text-xs font-semibold text-amber-700">
                        {t('pos.overageTitle', { amount: formatCurrency(overage) })}
                      </p>
                      <p className="text-center text-[11px] leading-tight text-amber-700/80">
                        {t('pos.overageHint')}
                      </p>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          aria-pressed={overageMode === 'tip'}
                          onClick={() => setOverageMode('tip')}
                          className={cn(
                            'flex h-20 flex-col items-center justify-center gap-1 rounded-xl border-2 px-2 text-center transition active:scale-95',
                            overageMode === 'tip'
                              ? 'border-emerald-600 bg-emerald-50 text-emerald-700'
                              : 'border-border bg-white text-stone-600 hover:border-emerald-600/40',
                          )}
                        >
                          <HandCoins className="size-6 shrink-0" aria-hidden />
                          <span className="text-sm font-bold leading-tight">{t('pos.overageTip')}</span>
                          <span className="text-[11px] leading-tight opacity-80">
                            {t('pos.overageTipSub')}
                          </span>
                        </button>
                        <button
                          type="button"
                          aria-pressed={overageMode === 'change'}
                          onClick={() => setOverageMode('change')}
                          className={cn(
                            'flex h-20 flex-col items-center justify-center gap-1 rounded-xl border-2 px-2 text-center transition active:scale-95',
                            overageMode === 'change'
                              ? 'border-amber-600 bg-amber-100 text-amber-800'
                              : 'border-border bg-white text-stone-600 hover:border-amber-600/40',
                          )}
                        >
                          <Coins className="size-6 shrink-0" aria-hidden />
                          <span className="text-sm font-bold leading-tight">{t('pos.overageChange')}</span>
                          <span className="text-[11px] leading-tight opacity-80">
                            {t('pos.overageChangeSub', { amount: formatCurrency(overage) })}
                          </span>
                        </button>
                      </div>
                      {overageMode === 'change' && <ChangeBreakdown change={overage} />}
                    </div>
                  )}
                </div>
              ) : (
                <PayRow
                  label={t('pos.payment')}
                  method={singleRow.method}
                  active
                  amountStr={singleRow.amount}
                  onAmountChange={(v) => setSingleRow((r) => ({ ...r, amount: v }))}
                  editable
                  error={
                    singleExceeds
                      ? t('pos.exceedsBy', {
                          amount: formatCurrency(round2(parseAmount(singleRow.amount) - remaining)),
                        })
                      : undefined
                  }
                />
              )}
            </TabsContent>

            {/* ── Equal Split ── */}
            <TabsContent value="equal" className="space-y-3 pt-3">
              <div className="flex items-center gap-3 rounded-xl border border-border bg-white p-2.5">
                <Users className="size-4 text-muted-foreground" />
                <span className="flex-1 text-sm font-medium">{t('pos.splitBetween')}</span>
                <Input
                  type="number"
                  min={2}
                  max={12}
                  value={eqPayers}
                  onChange={(e) => {
                    const next = clampPayers(parseInt(e.target.value, 10) || 2, 2, 12)
                    setEqPayers(next)
                    setActiveIdx((i) => Math.min(i, next - 1))
                    writePaymentPrefs({ tab, eqPayers: next, itPayers })
                  }}
                  className="h-10 w-16 text-center tabular-nums"
                />
                <span className="text-sm text-muted-foreground">{t('pos.payers')}</span>
              </div>
              {/* R11: customer-by-customer navigation — advances the payer the
                  method tiles + tips target. */}
              <PayerNav count={eqPayers} activeIdx={safeActiveIdx} onSelect={setActiveIdx} isRTL={isRTL} />
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
              <div className="flex items-center gap-3 rounded-xl border border-border bg-white p-2.5">
                <Users className="size-4 text-muted-foreground" />
                <span className="flex-1 text-sm font-medium">{t('pos.assignItemsTo')}</span>
                <Input
                  type="number"
                  min={2}
                  max={6}
                  value={itPayers}
                  onChange={(e) => {
                    const next = clampPayers(parseInt(e.target.value, 10) || 2, 2, 6)
                    setItPayers(next)
                    // p8: keep unit allocations sized to the payer count
                    setQtyAllocations((prev) => {
                      if (Object.keys(prev).length === 0) return prev
                      const out: Record<number, number[]> = {}
                      for (const [k, arr] of Object.entries(prev)) {
                        out[Number(k)] = arr.slice(0, next)
                      }
                      return out
                    })
                    writePaymentPrefs({ tab, eqPayers, itPayers: next })
                  }}
                  className="h-10 w-16 text-center tabular-nums"
                />
                <span className="text-sm text-muted-foreground">{t('pos.payers')}</span>
              </div>

              <div className="space-y-1.5">
                {itemLines.map((line) => {
                  const active = Math.min(assignments[line.id] ?? 0, itPayers - 1)
                  const multi = line.qty > 1
                  const alloc = allocArray(line.id)
                  const allocatedTotal = allocatedWholeUnits(line.id, alloc)
                  const wholeUnits = Math.floor(line.qty)
                  const unallocated = Math.max(0, line.qty - allocatedTotal)
                  return (
                    <div key={line.id} className="rounded-xl border border-border bg-white p-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{line.label}</p>
                          <p className="text-xs text-muted-foreground tabular-nums">
                            {formatCurrency(line.total)}
                            {multi && unallocated > 0.001 && (
                              <span className="ms-1.5 font-semibold text-amber-700">
                                · {t('pos.unitsLeft', { n: formatQty(unallocated) })} →{' '}
                                {t('pos.payer', { n: active + 1 })}
                              </span>
                            )}
                          </p>
                        </div>
                        {multi && (
                          <button
                            type="button"
                            onClick={() => spreadEvenly(line.id, line.qty)}
                            className="h-9 shrink-0 rounded-lg border-2 border-primary/40 bg-primary/5 px-3 text-xs font-bold text-primary transition active:scale-95 hover:bg-primary/10"
                            title={t('pos.spreadEvenlyHint')}
                          >
                            {t('pos.spreadEvenly')}
                          </button>
                        )}
                      </div>
                      {multi ? (
                        /* p8: per-payer unit steppers — hand out this line's
                         * units one by one (5 × Pizza → 1 each). Tapping a
                         * payer's badge picks who gets the LEFTOVER units. */
                        <div className="mt-1.5 space-y-1">
                          <div className="flex flex-wrap gap-1">
                            {Array.from({ length: itPayers }, (_, p) => {
                              const units = qtyForPayerOf(line, p, assignments, qtyAllocations)
                              const explicit = alloc[p] ?? 0
                              const canAdd =
                                allocatedTotal < wholeUnits ||
                                (alloc[active] > 0 && p !== active)
                              const canRemove = explicit > 0
                              return (
                                <div
                                  key={p}
                                  className={cn(
                                    'flex h-9 items-center gap-0.5 rounded-lg border px-1 text-xs font-semibold transition-colors',
                                    units > 0
                                      ? 'border-primary bg-primary/10 text-primary'
                                      : 'border-border bg-muted/50 text-muted-foreground',
                                  )}
                                >
                                  <button
                                    type="button"
                                    onClick={() => setAssignment(line.id, p)}
                                    aria-pressed={active === p}
                                    aria-label={t('pos.payer', { n: p + 1 })}
                                    title={t('pos.basePayerHint')}
                                    className={cn(
                                      'h-7 min-w-8 rounded-md px-1.5 text-xs font-bold transition-colors',
                                      active === p
                                        ? 'bg-primary text-white'
                                        : 'text-muted-foreground hover:bg-primary/10',
                                    )}
                                  >
                                    P{p + 1}
                                  </button>
                                  <button
                                    type="button"
                                    disabled={!canRemove}
                                    onClick={() => removeUnitFrom(line.id, p)}
                                    aria-label={t('pos.removeUnit', { n: p + 1 })}
                                    className="grid size-7 place-items-center rounded-md text-muted-foreground transition hover:bg-primary/10 disabled:opacity-30"
                                  >
                                    <Minus className="size-3.5" />
                                  </button>
                                  <span className="w-7 text-center text-sm font-bold tabular-nums">
                                    {formatQty(units)}
                                  </span>
                                  <button
                                    type="button"
                                    disabled={!canAdd}
                                    onClick={() => addUnitTo(line, p)}
                                    aria-label={t('pos.addUnit', { n: p + 1 })}
                                    className="grid size-7 place-items-center rounded-md text-muted-foreground transition hover:bg-primary/10 disabled:opacity-30"
                                  >
                                    <Plus className="size-3.5" />
                                  </button>
                                </div>
                              )
                            })}
                          </div>
                          <p className="text-[11px] leading-tight text-muted-foreground">
                            {t('pos.qtySplitHint')}
                          </p>
                        </div>
                      ) : (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {Array.from({ length: itPayers }, (_, p) => (
                            <button
                              key={p}
                              type="button"
                              onClick={() => setAssignment(line.id, p)}
                              className={cn(
                                'h-9 min-w-9 rounded-md border px-2 text-xs font-semibold transition-colors',
                                p === active
                                  ? 'border-primary bg-primary text-white'
                                  : 'border-border bg-muted/50 text-muted-foreground hover:border-primary/40',
                              )}
                              aria-pressed={p === active}
                            >
                              P{p + 1}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              <div className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t('pos.eachPayerPays')}
                </p>
                {/* R11: customer-by-customer navigation (see Equal Split) */}
                <PayerNav count={itPayers} activeIdx={safeActiveIdx} onSelect={setActiveIdx} isRTL={isRTL} />
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

          {/* R8: Tip — gratuity ON TOP of the bill, attached to the ACTIVE
              payment row (switch rows above to tip a different payer). */}
          <div className="space-y-2 rounded-xl border border-border bg-white p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
                <HandCoins className="size-4 shrink-0 text-emerald-600" aria-hidden />
                <span className="truncate">{t('pos.tipOn', { name: activeRowLabel })}</span>
              </p>
              <p
                className={cn(
                  'shrink-0 text-sm font-bold tabular-nums',
                  activeTip.value > 0 ? 'text-emerald-600' : 'text-muted-foreground',
                )}
              >
                {formatCurrency(activeTip.value)}
              </p>
            </div>
            <p className="-mt-1 text-xs text-muted-foreground">{t('pos.tipHint')}</p>
            <div className="grid grid-cols-5 gap-1.5">
              {TIP_PRESETS.map((pct) => {
                const active = activeSel === pct
                const presetAmount = round2((activeRowAmount * pct) / 100)
                return (
                  <button
                    key={pct}
                    type="button"
                    aria-pressed={active}
                    onClick={() => setTipSel((prev) => ({ ...prev, [activeTipKey]: pct }))}
                    className={cn(
                      'flex h-12 flex-col items-center justify-center rounded-lg border-2 px-1 text-xs font-semibold leading-tight transition active:scale-95',
                      active
                        ? 'border-emerald-600 bg-emerald-50 text-emerald-700'
                        : 'border-border bg-white text-stone-600 hover:border-emerald-600/40',
                    )}
                  >
                    <span>{pct === 0 ? t('pos.noTip') : `${pct}%`}</span>
                    {pct > 0 && (
                      <span className="text-[10px] font-normal tabular-nums text-muted-foreground">
                        {formatCurrency(presetAmount)}
                      </span>
                    )}
                  </button>
                )
              })}
              <button
                type="button"
                aria-pressed={activeSel === 'custom'}
                onClick={() => setTipSel((prev) => ({ ...prev, [activeTipKey]: 'custom' }))}
                className={cn(
                  'flex h-12 items-center justify-center rounded-lg border-2 px-1 text-xs font-semibold transition active:scale-95',
                  activeSel === 'custom'
                    ? 'border-emerald-600 bg-emerald-50 text-emerald-700'
                    : 'border-border bg-white text-stone-600 hover:border-emerald-600/40',
                )}
              >
                {t('pos.tipCustom')}
              </button>
            </div>
            {activeSel === 'custom' && (
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={0}
                  step={0.5}
                  inputMode="decimal"
                  value={activeCustomText}
                  onChange={(e) =>
                    setTipCustom((prev) => ({ ...prev, [activeTipKey]: e.target.value }))
                  }
                  placeholder="0.00"
                  aria-label={t('pos.tip')}
                  className="h-11 w-28 text-right text-sm font-semibold tabular-nums"
                />
                {activeTip.invalid && (
                  <p className="text-xs font-medium text-destructive">{t('pos.tipInvalid')}</p>
                )}
              </div>
            )}
            {/* R26: keep-the-change overage landing on the single tip */}
            {tipFromChange > 0 && (
              <p className="rounded-md bg-emerald-50 px-2.5 py-1.5 text-center text-xs font-semibold text-emerald-700">
                {t('pos.tipFromChange', { amount: formatCurrency(tipFromChange) })}
              </p>
            )}
          </div>

          {/* Live total + submit */}
          <div className="space-y-2 border-t border-border pt-3">
            {tipsTotal > 0 && (
              <div className="flex items-center justify-between gap-2 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                <span className="flex min-w-0 items-center gap-1.5 font-medium">
                  <HandCoins className="size-4 shrink-0" aria-hidden />
                  {t('pos.tipTotal')}
                </span>
                <span className="shrink-0 font-semibold tabular-nums">
                  {formatCurrency(sum)} + {formatCurrency(tipsTotal)} ={' '}
                  {formatCurrency(round2(sum + tipsTotal))}
                </span>
              </div>
            )}
            <div
              className={cn(
                'flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium',
                exceeds
                  ? 'bg-rose-50 text-rose-700'
                  : exact || (singleCash && overage > 0)
                    ? 'bg-emerald-50 text-emerald-700'
                    : 'bg-amber-50 text-amber-700',
              )}
            >
              {singleCash && overage > 0 ? (
                overageMode === 'change' ? (
                  <>
                    <Coins className="size-4" aria-hidden /> {t('pos.changeDue')}: {formatCurrency(overage)}
                  </>
                ) : (
                  <>
                    <HandCoins className="size-4" aria-hidden /> {t('pos.tip')}: +{formatCurrency(overage)}
                  </>
                )
              ) : exceeds ? (
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
                className="h-12 rounded-xl border-border"
                onClick={() => setCheckOpen(true)}
                title={t('pos.printCheckPaymentHint')}
              >
                <Printer />
                <span className="hidden sm:inline">{t('pos.printCheck')}</span>
              </Button>
              {canDefer && (
                <Button
                  variant="outline"
                  className="h-12 rounded-xl border-violet-400 text-violet-700 hover:bg-violet-50 hover:text-violet-800"
                  onClick={() => setDeferOpen(true)}
                  title={t('pos.deferredDesc')}
                >
                  <Hourglass />
                  <span className="hidden lg:inline">{t('pos.deferredButton')}</span>
                </Button>
              )}
              <Button
                className="h-12 flex-[1.8] rounded-xl bg-emerald-600 text-base font-semibold text-white hover:bg-emerald-700"
                disabled={!canSubmit}
                onClick={handleSubmit}
              >
                {submitting ? <Loader2 className="animate-spin" /> : <CreditCard />}
                {t('pos.charge')} {formatCurrency(tipsTotal > 0 ? round2(sum + tipsTotal) : sum)}
              </Button>
            </div>
          </div>

          {/* Receipt is rendered by the parent (pos-view) after full payment */}
        </DialogContent>
        )}
      </Dialog>

      {/* Guest check for the CURRENT split configuration — printing does NOT
          record payments; the payment modal stays open behind it. */}
      <CheckModal order={order} open={checkOpen} onOpenChange={setCheckOpen} rows={checkRows} />

      {/* Defer-payment dialog — client name is required; the check stays
          open as a receivable and the table is released for cleanup. */}
      <Dialog open={deferOpen} onOpenChange={setDeferOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Hourglass className="size-5 text-violet-600" /> {t('pos.deferredTitle')}
            </DialogTitle>
            <DialogDescription>{t('pos.deferredDesc')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="defer-client-name">
              {t('pos.deferredNameLabel')} *
            </label>
            <input
              id="defer-client-name"
              value={deferName}
              onChange={(e) => setDeferName(e.target.value)}
              placeholder={t('pos.deferredNamePlaceholder')}
              maxLength={60}
              autoFocus
              className="h-11 w-full rounded-xl border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void handleDefer()
                }
              }}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" className="h-11" onClick={() => setDeferOpen(false)} disabled={deferSubmitting}>
              {t('common.cancel')}
            </Button>
            <Button
              className="h-11 bg-violet-600 text-white hover:bg-violet-700"
              onClick={() => void handleDefer()}
              disabled={deferSubmitting || deferName.trim().length === 0}
            >
              {deferSubmitting ? <Loader2 className="animate-spin" /> : <Hourglass />}
              {t('pos.deferredButton')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function toSubmitRow(r: EditableRow): SubmitRow {
  return {
    method: r.method,
    amount: parseAmount(r.amount),
  }
}

/** Parse a custom tip input: null = invalid (blocks submit), '' = 0, else ≥ 0 rounded. */
function parseTipInput(s: string): number | null {
  if (s.trim() === '') return 0
  const v = Number(s)
  if (!Number.isFinite(v) || v < 0) return null
  return round2(v)
}

/** R11: customer-by-customer navigation for the split tabs — a big Next
 *  button (and smaller Back) advances the active payer that the method
 *  tiles + tips target; compact chips 1..N jump straight to a payer. */
function PayerNav({
  count,
  activeIdx,
  onSelect,
  isRTL,
}: {
  count: number
  activeIdx: number
  onSelect: (idx: number) => void
  isRTL: boolean
}) {
  const { t } = useI18n()
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-muted/40 p-2">
      <Button
        variant="outline"
        size="icon"
        className="size-11 shrink-0 rounded-xl"
        disabled={activeIdx <= 0}
        onClick={() => onSelect(Math.max(0, activeIdx - 1))}
        aria-label={t('pos.payerPrev')}
        title={t('pos.payerPrev')}
      >
        {isRTL ? <ChevronRight className="size-5" /> : <ChevronLeft className="size-5" />}
      </Button>
      <div className="min-w-0 flex-1 text-center">
        <p className="text-sm font-bold tabular-nums text-primary">
          {t('pos.payerOf', { n: activeIdx + 1, m: count })}
        </p>
        <div className="mt-1 flex flex-wrap justify-center gap-1">
          {Array.from({ length: count }, (_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onSelect(i)}
              aria-pressed={activeIdx === i}
              aria-label={t('pos.payer', { n: i + 1 })}
              className={cn(
                'h-10 min-w-10 rounded-full border px-2 text-xs font-bold tabular-nums transition-colors',
                activeIdx === i
                  ? 'border-primary bg-primary text-white'
                  : 'border-border bg-white text-stone-600 hover:border-primary/40',
              )}
            >
              {i + 1}
            </button>
          ))}
        </div>
      </div>
      <Button
        className="h-11 shrink-0 rounded-xl bg-primary px-5 font-semibold text-white hover:bg-primary/90"
        disabled={activeIdx >= count - 1}
        onClick={() => onSelect(Math.min(count - 1, activeIdx + 1))}
      >
        {t('pos.payerNext')}
        {isRTL ? <ChevronLeft className="size-4" /> : <ChevronRight className="size-4" />}
      </Button>
    </div>
  )
}

function PayRow({
  label,
  method,
  active = false,
  onActivate,
  amount,
  amountStr,
  onAmountChange,
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
        active
          ? 'border-primary bg-primary/[0.06] shadow-sm ring-1 ring-primary'
          : 'border-border bg-white',
      )}
      onClick={() => onActivate?.()}
      title={onActivate ? t('pos.selectRowHint') : undefined}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span className={cn('text-sm', active ? 'font-bold text-primary' : 'font-medium')}>{label}</span>
          <span
            className={cn(
              'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold',
              active ? 'bg-primary text-white' : 'bg-primary/10 text-primary',
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
      {error && <p className="mt-1.5 text-xs font-medium text-destructive">{error}</p>}
    </div>
  )
}

/**
 * R26: note & coin breakdown for a change amount — the waiter counts the
 * exact notes/coins back to the guest without doing any math.
 * e.g. 67.50 → EGP 50 ×1 · EGP 10 ×1 · EGP 5 ×1 · EGP 1 ×2 · 50pt ×1
 */
function ChangeBreakdown({ change }: { change: number }) {
  const { t } = useI18n()
  const parts = breakdownChange(change)
  if (parts.length === 0) return null
  return (
    <div className="space-y-1.5">
      <p className="text-center text-[11px] font-semibold uppercase tracking-wide text-amber-700">
        {t('pos.changeBreakdown')} · {t('pos.changeBreakdownHint')}
      </p>
      <div className="flex flex-wrap justify-center gap-1.5">
        {parts.map((p) => (
          <span
            key={p.denom}
            className="inline-flex h-11 items-center gap-1.5 rounded-xl border-2 border-amber-400 bg-white px-3 text-sm font-bold tabular-nums text-amber-800"
          >
            {denomLabel(p.denom)}
            <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">×{p.count}</span>
          </span>
        ))}
      </div>
    </div>
  )
}
