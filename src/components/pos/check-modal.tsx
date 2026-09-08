'use client'

import { useState, type ReactNode } from 'react'
import { Check, Minus, Plus, Printer, ReceiptText } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { SERVICE_TAX_RATE, TAX_RATE } from '@/lib/constants'
import { formatCurrency, formatDateTime, formatQty } from '@/lib/format'
import { bilingualLabel, bothLabels, localizedName, useI18n, type Lang } from '@/lib/i18n'
import { useAppSettings } from '@/lib/use-settings'
import { cn } from '@/lib/utils'
import type { Order } from '@/lib/types'
import { escapeHtml, round2 } from './pos-utils'

/** A split part of the check (when opened from the payment modal, mirrors its split config). */
export type CheckSplitRow = { label: string; amount: number; method?: string }

type CheckModalProps = {
  order: Order
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Optional split rows (from the payment modal) — defaults the modal to Split mode showing them. */
  rows?: CheckSplitRow[]
}

type CheckTitleKey = 'guestCheck' | 'bill' | 'invoice'
const CHECK_TITLE_KEYS: CheckTitleKey[] = ['guestCheck', 'bill', 'invoice']
const CHECK_TITLE_LABEL_KEYS: Record<CheckTitleKey, string> = {
  guestCheck: 'pos.titleGuestCheck',
  bill: 'pos.titleBill',
  invoice: 'pos.titleInvoice',
}

type SplitKind = 'rows' | 'equal' | 'items'

// ── Bilingual label helpers (the paper ALWAYS shows EN + AR) ─────────

/** "English · العربية" from a template key with its {vars} filled in. */
function bilingualVars(key: string, vars: Record<string, string | number>): string {
  const { en, ar } = bothLabels(key)
  const fill = (tpl: string) =>
    Object.entries(vars).reduce((s, [name, v]) => s.split(`{${name}}`).join(String(v)), tpl)
  const enFilled = fill(en)
  const arFilled = fill(ar)
  return enFilled === arFilled ? enFilled : `${enFilled} · ${arFilled}`
}

/**
 * Payment-plan rows arrive with UI-language labels built by the payment
 * modal ("Part 1 of 3", "Payer 2", "Full bill"…). The printed paper shows
 * BOTH languages, so reverse-match the label against the known templates
 * and rebuild it bilingually; unknown labels pass through untouched.
 */
const SPLIT_LABEL_KEYS = ['pos.fullBill', 'pos.partOf', 'pos.payer', 'pos.paymentN'] as const

function bilingualSplitLabel(label: string): string {
  for (const key of SPLIT_LABEL_KEYS) {
    const { en, ar } = bothLabels(key)
    if (label === en || label === ar) return en === ar ? en : `${en} · ${ar}`
    for (const tpl of [en, ar]) {
      if (!tpl.includes('{')) continue
      const pattern = tpl
        .replace(/\{[a-zA-Z]+\}/g, '\u0000')
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\u0000/g, '(\\d+)')
      const m = label.match(new RegExp(`^${pattern}$`))
      if (!m) continue
      const names = Array.from(tpl.matchAll(/\{([a-zA-Z]+)\}/g), (x) => x[1])
      const vars: Record<string, string | number> = {}
      names.forEach((name, i) => {
        vars[name] = m[i + 1] ?? ''
      })
      return bilingualVars(key, vars)
    }
  }
  return label
}

type CheckModel = {
  /** bilingual "Guest Check · حساب الضيف" */
  title: string
  customer: string
  orderId: number
  tableName: string
  waiter: string
  date: string
  items: {
    qty: string
    name: string
    nameAr: string | null
    total: number
    notes: string | null
    /** R8: selected options (localized names) shown as sub-lines */
    mods: string | null
  }[]
  subtotal: number
  discount: number
  /** 14% VAT */
  tax: number
  /** 12% service tax (in addition to the VAT) */
  serviceTax: number
  total: number
  paid: number
  remaining: number
  /** deferred check (client pays later) — stamped on the paper */
  deferred: boolean
  clientName: string | null
  split: CheckSplitRow[] | null
  splitTotal: number | null
  reference: { label: string; amount: number }[]
}

function buildCheckModel(
  order: Order,
  opts: {
    title: string
    customer: string
    mode: 'full' | 'split'
    splitKind: SplitKind
    rows: CheckSplitRow[] | undefined
    eqPayers: number
    selectedIds: Set<number>
    lang: Lang
  },
): CheckModel {
  // Paper item lines are bilingual: English primary + Arabic secondary.
  const fallbackItem = bothLabels('pos.item')
  const base = {
    title: opts.title,
    customer: opts.customer.trim(),
    orderId: order.id,
    tableName: order.table?.name ?? bilingualLabel('common.takeaway'),
    waiter: order.user?.name ?? '—',
    date: formatDateTime(order.createdAt),
  }
  const allItems = order.items.map((it) => {
    const name = it.product?.name ?? fallbackItem.en
    let nameAr: string | null = null
    if (it.product?.nameAr && it.product.nameAr.trim()) nameAr = it.product.nameAr.trim()
    else if (!it.product) nameAr = fallbackItem.ar
    return {
      qty: formatQty(it.quantity),
      name,
      nameAr: nameAr && nameAr !== name ? nameAr : null,
      total: round2(it.quantity * it.unitPrice),
      notes: it.notes,
      mods:
        it.selectedModifiers && it.selectedModifiers.length > 0
          ? it.selectedModifiers
              .map((m) => localizedName(m.name, m.nameAr, opts.lang))
              .join(', ')
          : null,
    }
  })
  const orderSubtotal = round2(order.subtotalAmount)
  const orderDiscount = round2(order.discountAmount)
  const orderTotal = round2(order.totalAmount)
  const paid = round2(order.paidAmount)
  const remaining = round2(Math.max(0, order.remainingAmount))
  const deferred = order.status === 'deferred'
  const clientName = deferred ? order.clientName : null
  const isSplit = opts.mode === 'split'

  // ── By items: the check covers ONLY the selected items ──
  if (isSplit && opts.splitKind === 'items') {
    const items = allItems.filter((_, i) => opts.selectedIds.has(order.items[i].id))
    const lineSum = round2(items.reduce((s, it) => s + it.total, 0))
    const ratio = orderSubtotal > 0 ? lineSum / orderSubtotal : 0
    const discount = round2(orderDiscount * ratio)
    const baseAmount = Math.max(0, round2(lineSum - discount))
    const tax = round2(baseAmount * TAX_RATE)
    const serviceTax = round2(baseAmount * SERVICE_TAX_RATE)
    const total = round2(baseAmount + tax + serviceTax)
    return {
      ...base,
      items,
      subtotal: lineSum,
      discount,
      tax,
      serviceTax,
      total,
      paid,
      remaining,
      deferred,
      clientName,
      split: null,
      splitTotal: null,
      reference: [
        { label: bilingualLabel('pos.fullBillTotal'), amount: orderTotal },
        { label: bilingualLabel('pos.remainingOnBill'), amount: remaining },
      ],
    }
  }

  // ── Full bill / payment-plan rows / equal split: itemized full bill ──
  let split: CheckSplitRow[] | null = null
  if (isSplit && opts.splitKind === 'rows' && opts.rows && opts.rows.length > 0) {
    // mirror rows of the payment modal's split chips — printed bilingually
    split = opts.rows.map((r) => ({ ...r, label: bilingualSplitLabel(r.label) }))
  } else if (isSplit && opts.splitKind === 'equal') {
    const part = round2(remaining / opts.eqPayers)
    const amounts = Array.from({ length: opts.eqPayers }, () => part)
    amounts[opts.eqPayers - 1] = round2(Math.max(0, remaining - round2(part * (opts.eqPayers - 1))))
    split = amounts.map((amount, i) => ({
      label: bilingualVars('pos.partOf', { i: i + 1, n: opts.eqPayers }),
      amount,
    }))
  }

  return {
    ...base,
    items: allItems,
    subtotal: orderSubtotal,
    discount: orderDiscount,
    tax: round2(order.taxAmount),
    serviceTax: round2(order.serviceTaxAmount),
    total: orderTotal,
    paid,
    remaining,
    deferred,
    clientName,
    split,
    splitTotal: split ? round2(split.reduce((s, r) => s + r.amount, 0)) : null,
    reference: [],
  }
}

function buildCheckHtml(
  m: CheckModel,
  restaurantName: string,
  restaurantNameAr: string,
  isRTL: boolean,
): string {
  const row = (l: string, r: string, cls = '') =>
    `<div class="r ${cls}"><span>${escapeHtml(l)}</span><span>${escapeHtml(r)}</span></div>`
  const dashed = '<div class="dashed"></div>'
  const center = (text: string, cls = '') => `<p class="${cls}">${escapeHtml(text)}</p>`
  // Arabic secondary lines: RTL direction, aligned with the paper's text edge.
  const arAlign = isRTL ? 'right' : 'left'
  const deferredStamp = bothLabels('pos.deferredStamp')
  const lines: string[] = []
  lines.push(`<h3>${escapeHtml(restaurantName)}</h3>`)
  lines.push(`<p class="arn" dir="rtl">${escapeHtml(restaurantNameAr)}</p>`)
  lines.push(center(m.title.toUpperCase()))
  if (m.customer)
    lines.push(
      `<p class="cust">${escapeHtml(bilingualLabel('pos.customer'))}: ${escapeHtml(m.customer)}</p>`,
    )
  lines.push(dashed)
  lines.push(row(`${bilingualLabel('common.order')} #${m.orderId}`, m.tableName))
  lines.push(row(bilingualLabel('pos.waiter'), m.waiter))
  lines.push(row(bilingualLabel('common.date'), m.date))
  lines.push(dashed)
  for (const it of m.items) {
    lines.push(row(`${it.qty}× ${it.name}`, formatCurrency(it.total)))
    if (it.nameAr) lines.push(`<p class="ar" dir="rtl">${escapeHtml(it.nameAr)}</p>`)
    if (it.mods) lines.push(`<p class="note">  + ${escapeHtml(it.mods)}</p>`)
    if (it.notes) lines.push(`<p class="note">  * ${escapeHtml(it.notes)}</p>`)
  }
  lines.push(dashed)
  lines.push(row(bilingualLabel('money.subtotal'), formatCurrency(m.subtotal)))
  if (m.discount > 0) lines.push(row(bilingualLabel('money.discount'), `-${formatCurrency(m.discount)}`))
  lines.push(row(bilingualLabel('money.tax'), formatCurrency(m.tax)))
  lines.push(row(bilingualLabel('money.serviceTax'), formatCurrency(m.serviceTax)))
  lines.push(row(bilingualLabel('money.total'), formatCurrency(m.total), 'bold'))
  if (m.deferred) {
    lines.push(
      `<p class="stampline"><span class="stampd"><span class="se">${escapeHtml(
        deferredStamp.en,
      )}</span><span class="sep"> · </span><span class="sar" dir="rtl">${escapeHtml(
        deferredStamp.ar,
      )}</span></span></p>`,
    )
    if (m.clientName)
      lines.push(row(bilingualLabel('pos.deferredClientLabel'), m.clientName))
  }
  if (m.paid > 0) lines.push(row(bilingualLabel('money.paid'), formatCurrency(m.paid)))
  if (m.split && m.split.length > 0) {
    lines.push(dashed)
    lines.push(center(bilingualLabel('pos.splitBill').toUpperCase(), 'bold'))
    m.split.forEach((p) => {
      const method = p.method ? ` (${bilingualLabel(`status.payment.${p.method}`)})` : ''
      lines.push(row(`${p.label}${method}`, formatCurrency(p.amount)))
    })
    if (m.splitTotal != null)
      lines.push(row(bilingualLabel('pos.splitTotal'), formatCurrency(m.splitTotal), 'bold'))
    lines.push(row(bilingualLabel('pos.remainingTotal'), formatCurrency(m.remaining)))
  }
  for (const ref of m.reference) lines.push(row(ref.label, formatCurrency(ref.amount)))
  lines.push(dashed)
  lines.push(center(bilingualLabel('pos.checkFooter')))
  return lines.join('\n')
}

export default function CheckModal({ order, open, onOpenChange, rows }: CheckModalProps) {
  const { t, lang, isRTL } = useI18n()
  const { restaurantName, restaurantNameAr } = useAppSettings()
  // Initial state is derived from the props at mount time — parents mount this
  // modal fresh whenever a new check flow starts (pos-view keys it by order,
  // the payment modal keeps it mounted for one payment session). The `rows`
  // prop itself is read LIVE so a check opened from the payment screen always
  // mirrors its CURRENT split configuration.
  const [customerName, setCustomerName] = useState('')
  const [title, setTitle] = useState<CheckTitleKey>('guestCheck')
  const [mode, setMode] = useState<'full' | 'split'>(() => ((rows?.length ?? 0) > 0 ? 'split' : 'full'))
  const [splitKind, setSplitKind] = useState<SplitKind>(() => ((rows?.length ?? 0) > 0 ? 'rows' : 'equal'))
  const [eqPayers, setEqPayers] = useState(2)
  const [selectedIds, setSelectedIds] = useState<Set<number>>(
    () => new Set(order.items.map((it) => it.id)),
  )

  const hasRows = (rows?.length ?? 0) > 0
  const effSplitKind: SplitKind = hasRows ? splitKind : splitKind === 'rows' ? 'equal' : splitKind
  const titleLabel = t(CHECK_TITLE_LABEL_KEYS[title])
  // The paper title is always bilingual (EN · AR), independent of the UI language.
  const titleBi = bilingualLabel(CHECK_TITLE_LABEL_KEYS[title])

  const model = buildCheckModel(order, {
    title: titleBi,
    customer: customerName,
    mode,
    splitKind: effSplitKind,
    rows,
    eqPayers,
    selectedIds,
    lang,
  })

  const clampPayers = (raw: number) => {
    const n = Math.round(Number.isFinite(raw) ? raw : 2)
    return Math.min(12, Math.max(2, n))
  }

  const toggleItem = (itemId: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })
  }

  const selectedCount = order.items.filter((it) => selectedIds.has(it.id)).length
  const selectedSum = round2(
    order.items
      .filter((it) => selectedIds.has(it.id))
      .reduce((s, it) => s + it.quantity * it.unitPrice, 0),
  )

  const handlePrint = () => {
    const html = buildCheckHtml(model, restaurantName, restaurantNameAr, isRTL)
    const w = window.open('', '_blank', 'width=380,height=640')
    if (!w) {
      window.alert(t('pos.popupBlocked'))
      return
    }
    const noteAlign = isRTL ? 'right' : 'left'
    const arAlign = isRTL ? 'right' : 'left'
    // Letter-spacing on the Latin part only (Arabic letters must stay joined),
    // and only when the UI language is English.
    const stampSpacing = isRTL ? 'normal' : '4px'
    w.document.write(
      `<html dir="${isRTL ? 'rtl' : 'ltr'}" lang="${lang}"><head><meta charset="utf-8"><title>${escapeHtml(
        model.title,
      )}</title><style>body{font-family:monospace;font-size:13px;padding:24px;width:320px} .r{display:flex;justify-content:space-between} .dashed{border-top:1px dashed #000;margin:8px 0} h3,p{margin:2px 0;text-align:center} .cust{font-weight:bold;margin:2px 0;text-align:center} .note{font-size:11px;text-align:${noteAlign};margin:0} .bold{font-weight:bold} .ar{font-size:11px;text-align:${arAlign};direction:rtl;margin:0} .arn{font-weight:bold;direction:rtl;margin:2px 0} .stampline{margin:10px 0;text-align:center} .stampd{font-weight:bold;border:2px solid #7C3AED;color:#7C3AED;display:inline-block;padding:2px 10px;transform:rotate(-6deg)} .stampd .se{letter-spacing:${stampSpacing}} .stampd .sar{direction:rtl} .stampd .sep{letter-spacing:normal}</style></head><body>${html}</body></html>`,
    )
    w.document.close()
    w.focus()
    w.print()
  }

  const deferredStamp = bothLabels('pos.deferredStamp')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ReceiptText className="size-5 text-[#714B67]" /> {t('pos.printCheck')} —{' '}
            {t('common.order')} #{order.id}
          </DialogTitle>
          <DialogDescription>{t('pos.checkDesc')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_320px] md:items-start">
          {/* ── Controls ── */}
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="check-customer">{t('pos.customerNameHint')}</Label>
              <Input
                id="check-customer"
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
                placeholder={t('pos.customerPlaceholder')}
                maxLength={60}
                className="h-11 rounded-xl"
              />
            </div>

            <div className="space-y-1.5">
              <Label>{t('pos.checkTitleLabel')}</Label>
              <Select value={title} onValueChange={(v) => setTitle(v as CheckTitleKey)}>
                <SelectTrigger className="h-11 w-full rounded-xl">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CHECK_TITLE_KEYS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {t(CHECK_TITLE_LABEL_KEYS[k])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>{t('pos.mode')}</Label>
              <Tabs value={mode} onValueChange={(v) => setMode(v as 'full' | 'split')}>
                <TabsList className="grid h-11 w-full grid-cols-2 rounded-xl">
                  <TabsTrigger value="full" className="rounded-lg text-sm">
                    {t('pos.fullBill')}
                  </TabsTrigger>
                  <TabsTrigger value="split" className="rounded-lg text-sm">
                    {t('pos.split')}
                  </TabsTrigger>
                </TabsList>
              </Tabs>
            </div>

            {mode === 'split' && (
              <div className="space-y-3 rounded-xl border border-[#E2E2E0] bg-white p-3">
                <div className="flex flex-wrap gap-2">
                  {hasRows && (
                    <SplitPill active={splitKind === 'rows'} onClick={() => setSplitKind('rows')}>
                      {t('pos.paymentPlan')}
                    </SplitPill>
                  )}
                  <SplitPill active={splitKind === 'equal'} onClick={() => setSplitKind('equal')}>
                    {t('pos.equalSplit')}
                  </SplitPill>
                  <SplitPill active={splitKind === 'items'} onClick={() => setSplitKind('items')}>
                    {t('pos.byItems')}
                  </SplitPill>
                </div>

                {effSplitKind === 'rows' && rows && (
                  <div className="space-y-1.5">
                    {rows.map((r, i) => (
                      <div
                        key={i}
                        className="flex items-center justify-between gap-2 rounded-lg bg-muted/50 px-3 py-2 text-sm"
                      >
                        <span className="min-w-0 truncate">
                          {r.label}
                          {r.method && (
                            <span className="ms-1.5 text-xs text-muted-foreground">
                              ({t(`status.payment.${r.method}`)})
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 font-semibold tabular-nums text-[#714B67]">
                          {formatCurrency(r.amount)}
                        </span>
                      </div>
                    ))}
                    <p className="text-xs text-muted-foreground">{t('pos.mirrorHint')}</p>
                  </div>
                )}

                {effSplitKind === 'equal' && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">{t('pos.splitBetween')}</span>
                      <div className="flex items-center gap-1">
                        <Button
                          variant="outline"
                          size="icon"
                          className="size-11 rounded-lg"
                          disabled={eqPayers <= 2}
                          onClick={() => setEqPayers(clampPayers(eqPayers - 1))}
                          aria-label={t('pos.fewerPayers')}
                        >
                          <Minus />
                        </Button>
                        <span className="w-10 text-center text-base font-bold tabular-nums">
                          {eqPayers}
                        </span>
                        <Button
                          variant="outline"
                          size="icon"
                          className="size-11 rounded-lg"
                          disabled={eqPayers >= 12}
                          onClick={() => setEqPayers(clampPayers(eqPayers + 1))}
                          aria-label={t('pos.morePayers')}
                        >
                          <Plus />
                        </Button>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">{t('pos.equalHint')}</p>
                  </div>
                )}

                {effSplitKind === 'items' && (
                  <div className="space-y-2">
                    <div className="rms-scroll max-h-44 space-y-1.5 overflow-y-auto">
                      {order.items.map((it) => {
                        const active = selectedIds.has(it.id)
                        return (
                          <button
                            key={it.id}
                            type="button"
                            onClick={() => toggleItem(it.id)}
                            aria-pressed={active}
                            className={cn(
                              'flex h-11 w-full items-center justify-between gap-2 rounded-lg border px-3 text-start text-sm transition-colors',
                              active
                                ? 'border-[#714B67] bg-[#714B67]/10 font-semibold text-[#714B67]'
                                : 'border-[#E2E2E0] bg-white text-muted-foreground',
                            )}
                          >
                            <span className="min-w-0 truncate">
                              {formatQty(it.quantity)} ×{' '}
                              {it.product
                                ? localizedName(it.product.name, it.product.nameAr, lang)
                                : t('pos.item')}
                              {it.selectedModifiers?.length ? (
                                <span className="ms-1 text-xs text-muted-foreground">
                                  +{' '}
                                  {it.selectedModifiers
                                    .map((m) => localizedName(m.name, m.nameAr, lang))
                                    .join(', ')}
                                </span>
                              ) : null}
                            </span>
                            <span className="shrink-0 tabular-nums">
                              {formatCurrency(round2(it.quantity * it.unitPrice))}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {t('pos.selectedItems', {
                        n: selectedCount,
                        total: order.items.length,
                        amount: formatCurrency(selectedSum),
                      })}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Live preview (thermal style — bilingual EN + AR) ── */}
          <div className="rounded-xl bg-stone-200/70 p-3">
            <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-stone-500">
              <ReceiptText className="size-3.5" /> {t('pos.preview')}
            </p>
            <div className="mx-auto w-full max-w-[300px] rounded-md border border-stone-300 bg-white p-4 font-mono text-[12px] leading-tight text-stone-900 shadow-md">
              <p className="text-center font-bold uppercase tracking-widest">{restaurantName}</p>
              <p className="text-center font-bold" dir="rtl" lang="ar">
                {restaurantNameAr}
              </p>
              <p className="text-center uppercase">{model.title}</p>
              {model.customer && (
                <p className="text-center font-bold">
                  {bilingualLabel('pos.customer')}: {model.customer}
                </p>
              )}
              <div className="my-2 border-t border-dashed border-stone-400" />
              <CheckRow left={`${bilingualLabel('common.order')} #${model.orderId}`} right={model.tableName} />
              <CheckRow left={bilingualLabel('pos.waiter')} right={model.waiter} />
              <CheckRow left={bilingualLabel('common.date')} right={model.date} />
              <div className="my-2 border-t border-dashed border-stone-400" />
              {model.items.map((it, i) => (
                <div key={i}>
                  <CheckRow left={`${it.qty}× ${it.name}`} right={formatCurrency(it.total)} />
                  {it.nameAr && (
                    <p
                      className="text-left rtl:text-right text-[10px] text-stone-600"
                      dir="rtl"
                      lang="ar"
                    >
                      {it.nameAr}
                    </p>
                  )}
                  {it.mods && <p className="ps-3 text-[10px] text-stone-500">+ {it.mods}</p>}
                  {it.notes && <p className="ps-3 text-[10px] text-stone-500">* {it.notes}</p>}
                </div>
              ))}
              <div className="my-2 border-t border-dashed border-stone-400" />
              <CheckRow left={bilingualLabel('money.subtotal')} right={formatCurrency(model.subtotal)} />
              {model.discount > 0 && (
                <CheckRow left={bilingualLabel('money.discount')} right={`-${formatCurrency(model.discount)}`} />
              )}
              <CheckRow left={bilingualLabel('money.tax')} right={formatCurrency(model.tax)} />
              <CheckRow left={bilingualLabel('money.serviceTax')} right={formatCurrency(model.serviceTax)} />
              <CheckRow left={bilingualLabel('money.total')} right={formatCurrency(model.total)} bold />
              {model.deferred && (
                <>
                  <div className="my-2 flex justify-center">
                    <span className="inline-flex -rotate-6 items-baseline gap-1.5 rounded border-2 border-[#7C3AED] px-3 py-1 text-sm font-bold text-[#7C3AED]">
                      <span className={isRTL ? undefined : 'tracking-[0.3em]'}>
                        {deferredStamp.en}
                      </span>
                      <span aria-hidden>·</span>
                      <span dir="rtl" lang="ar">
                        {deferredStamp.ar}
                      </span>
                    </span>
                  </div>
                  {model.clientName && (
                    <CheckRow
                      left={bilingualLabel('pos.deferredClientLabel')}
                      right={model.clientName}
                    />
                  )}
                </>
              )}
              {model.paid > 0 && <CheckRow left={bilingualLabel('money.paid')} right={formatCurrency(model.paid)} />}
              {model.split && model.split.length > 0 && (
                <>
                  <div className="my-2 border-t border-dashed border-stone-400" />
                  <p className="text-center font-semibold uppercase">{bilingualLabel('pos.splitBill')}</p>
                  {model.split.map((p, i) => (
                    <CheckRow
                      key={i}
                      left={`${p.label}${p.method ? ` · ${bilingualLabel(`status.payment.${p.method}`)}` : ''}`}
                      right={formatCurrency(p.amount)}
                    />
                  ))}
                  {model.splitTotal != null && (
                    <CheckRow left={bilingualLabel('pos.splitTotal')} right={formatCurrency(model.splitTotal)} bold />
                  )}
                  <CheckRow left={bilingualLabel('pos.remainingTotal')} right={formatCurrency(model.remaining)} />
                </>
              )}
              {model.reference.map((r, i) => (
                <CheckRow key={i} left={r.label} right={formatCurrency(r.amount)} />
              ))}
              <div className="my-2 border-t border-dashed border-stone-400" />
              <p className="text-center">{bilingualLabel('pos.checkFooter')}</p>
            </div>
          </div>
        </div>

        <div className="flex gap-2 border-t pt-3">
          <Button variant="outline" className="h-12 flex-1 rounded-xl" onClick={() => onOpenChange(false)}>
            <Check /> {t('common.done')}
          </Button>
          <Button
            className="h-12 flex-[2] rounded-xl bg-[#714B67] text-base text-white hover:bg-[#714B67]/90"
            onClick={handlePrint}
          >
            <Printer /> {t('common.print')} {titleLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SplitPill({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'h-11 rounded-full px-4 text-sm font-semibold transition-colors disabled:opacity-50',
        active ? 'bg-[#714B67] text-white' : 'bg-white text-[#714B67] border border-[#714B67]/40 hover:bg-[#714B67]/10',
      )}
    >
      {children}
    </button>
  )
}

function CheckRow({ left, right, bold }: { left: string; right: string; bold?: boolean }) {
  return (
    <div className={cn('flex items-baseline gap-1', bold && 'font-bold')}>
      <span className="shrink-0">{left}</span>
      <span className="min-w-2 flex-1 border-b border-dotted border-stone-300" aria-hidden />
      <span className="shrink-0 tabular-nums">{right}</span>
    </div>
  )
}
