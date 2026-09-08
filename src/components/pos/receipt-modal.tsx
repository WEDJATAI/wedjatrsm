'use client'

import { Check, Printer } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { formatCurrency, formatDateTime, formatQty } from '@/lib/format'
import { bilingualLabel, bothLabels, useI18n } from '@/lib/i18n'
import { useAppSettings } from '@/lib/use-settings'
import type { Order } from '@/lib/types'
import { escapeHtml, round2 } from './pos-utils'

type ReceiptModalProps = {
  order: Order
  open: boolean
  onOpenChange: (open: boolean) => void
  onClose: () => void
}

type ReceiptModel = {
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
    /** R8: selected options — printed as indented sub-lines (bilingual) */
    mods: string | null
    modsAr: string | null
  }[]
  subtotal: number
  discount: number
  /** 14% VAT */
  tax: number
  /** 12% service tax (in addition to the VAT) */
  serviceTax: number
  total: number
  payments: { label: string; amount: number; tip: number }[]
  paid: number
  /** R8: Σ payment tips — gratuity is on top of the bill */
  tipsTotal: number
  /** R8: paid + tips — what the guest actually handed over */
  grandTotal: number
  /** deferred check (client pays later) — stamped on the paper */
  deferred: boolean
  clientName: string | null
}

function buildReceiptModel(order: Order): ReceiptModel {
  // Paper item lines are bilingual: English primary + Arabic secondary.
  const fallbackItem = bothLabels('pos.item')
  return {
    orderId: order.id,
    tableName: order.table?.name ?? bilingualLabel('common.takeaway'),
    waiter: order.user?.name ?? '—',
    date: formatDateTime(order.createdAt),
    items: order.items.map((it) => {
      const name = it.product?.name ?? fallbackItem.en
      let nameAr: string | null = null
      if (it.product?.nameAr && it.product.nameAr.trim()) nameAr = it.product.nameAr.trim()
      else if (!it.product) nameAr = fallbackItem.ar
      // R8: options snapshot — English + Arabic name lists (null when none)
      const mods = it.selectedModifiers?.length
        ? it.selectedModifiers.map((m) => m.name).join(', ')
        : null
      const modsAr = it.selectedModifiers?.length
        ? it.selectedModifiers
            .map((m) => (m.nameAr && m.nameAr.trim() ? m.nameAr.trim() : m.name))
            .join(', ')
        : null
      return {
        qty: formatQty(it.quantity),
        name,
        nameAr: nameAr && nameAr !== name ? nameAr : null,
        total: round2(it.quantity * it.unitPrice),
        notes: it.notes,
        mods,
        modsAr: modsAr && modsAr !== mods ? modsAr : null,
      }
    }),
    subtotal: round2(order.subtotalAmount),
    discount: round2(order.discountAmount),
    tax: round2(order.taxAmount),
    serviceTax: round2(order.serviceTaxAmount),
    total: round2(order.totalAmount),
    payments: order.payments.map((p) => ({
      label: `${bilingualLabel(`status.payment.${p.method}`)}${p.reference ? ` (${p.reference})` : ''}`,
      amount: round2(p.amount),
      tip: round2(p.tip ?? 0),
    })),
    paid: round2(order.paidAmount),
    tipsTotal: round2(order.payments.reduce((sum, p) => sum + (p.tip ?? 0), 0)),
    grandTotal: round2(order.paidAmount + order.payments.reduce((sum, p) => sum + (p.tip ?? 0), 0)),
    deferred: order.status === 'deferred',
    clientName: order.status === 'deferred' ? order.clientName : null,
  }
}

function buildReceiptHtml(
  m: ReceiptModel,
  restaurantName: string,
  restaurantNameAr: string,
  isRTL: boolean,
): string {
  const row = (l: string, r: string, cls = '') =>
    `<div class="r ${cls}"><span>${escapeHtml(l)}</span><span>${escapeHtml(r)}</span></div>`
  const dashed = '<div class="dashed"></div>'
  // Bilingual PAID stamp — letter-spacing only on the Latin part (Arabic
  // letters must stay joined), only when the UI language is English.
  const paidPair = bothLabels('pos.paidStamp')
  const stamp = `<p class="stampline"><span class="stamp"><span class="se">${escapeHtml(
    paidPair.en,
  )}</span><span class="sep"> · </span><span class="sar" dir="rtl">${escapeHtml(
    paidPair.ar,
  )}</span></span></p>`
  const deferredPair = bothLabels('pos.deferredStamp')
  const deferredStamp = `<p class="stampline"><span class="stampd"><span class="se">${escapeHtml(
    deferredPair.en,
  )}</span><span class="sep"> · </span><span class="sar" dir="rtl">${escapeHtml(
    deferredPair.ar,
  )}</span></span></p>`
  const lines: string[] = []
  lines.push(`<h3>${escapeHtml(restaurantName)}</h3>`)
  lines.push(`<p class="arn" dir="rtl">${escapeHtml(restaurantNameAr)}</p>`)
  lines.push(`<p>${escapeHtml(bilingualLabel('pos.salesReceipt'))}</p>`)
  lines.push(dashed)
  lines.push(row(`${bilingualLabel('common.order')} #${m.orderId}`, m.tableName))
  lines.push(row(bilingualLabel('pos.waiter'), m.waiter))
  lines.push(row(bilingualLabel('common.date'), m.date))
  lines.push(dashed)
  for (const it of m.items) {
    lines.push(row(`${it.qty}× ${it.name}`, formatCurrency(it.total)))
    if (it.nameAr) lines.push(`<p class="ar" dir="rtl">${escapeHtml(it.nameAr)}</p>`)
    if (it.mods) lines.push(`<p class="note">  + ${escapeHtml(it.mods)}</p>`)
    if (it.modsAr) lines.push(`<p class="ar">+ ${escapeHtml(it.modsAr)}</p>`)
    if (it.notes) lines.push(`<p class="note">  * ${escapeHtml(it.notes)}</p>`)
  }
  lines.push(dashed)
  lines.push(row(bilingualLabel('money.subtotal'), formatCurrency(m.subtotal)))
  if (m.discount > 0) lines.push(row(bilingualLabel('money.discount'), `-${formatCurrency(m.discount)}`))
  lines.push(row(bilingualLabel('money.tax'), formatCurrency(m.tax)))
  lines.push(row(bilingualLabel('money.serviceTax'), formatCurrency(m.serviceTax)))
  lines.push(row(bilingualLabel('money.total'), formatCurrency(m.total), 'bold'))
  if (m.deferred) {
    lines.push(deferredStamp)
    if (m.clientName)
      lines.push(row(bilingualLabel('pos.deferredClientLabel'), m.clientName))
  }
  if (m.payments.length > 0) {
    lines.push(dashed)
    for (const p of m.payments) {
      lines.push(row(`- ${p.label}`, formatCurrency(p.amount)))
      if (p.tip > 0) lines.push(row(`  + ${bilingualLabel('money.tip')}`, formatCurrency(p.tip)))
    }
    lines.push(row(bilingualLabel('money.paid'), formatCurrency(m.paid), 'bold'))
    if (m.tipsTotal > 0) {
      lines.push(row(bilingualLabel('money.tip'), formatCurrency(m.tipsTotal)))
      lines.push(row(bilingualLabel('money.grandTotal'), formatCurrency(m.grandTotal), 'bold'))
    }
    lines.push(stamp)
  }
  lines.push(dashed)
  lines.push(`<p>${escapeHtml(bilingualLabel('pos.thankYouReceipt'))}</p>`)
  return lines.join('\n')
}

export default function ReceiptModal({ order, open, onOpenChange, onClose }: ReceiptModalProps) {
  const { t, lang, isRTL } = useI18n()
  const { restaurantName, restaurantNameAr } = useAppSettings()
  const model = buildReceiptModel(order)
  const paidStamp = bothLabels('pos.paidStamp')
  const deferredStamp = bothLabels('pos.deferredStamp')

  const handlePrint = () => {
    const html = buildReceiptHtml(model, restaurantName, restaurantNameAr, isRTL)
    const w = window.open('', '_blank', 'width=380,height=640')
    if (!w) {
      window.alert(t('pos.receiptPopupBlocked'))
      return
    }
    const noteAlign = isRTL ? 'right' : 'left'
    // Arabic secondary lines: RTL direction, aligned with the paper's text edge.
    const arAlign = isRTL ? 'right' : 'left'
    // Arabic stamps don't get letter-spacing (it breaks joined letters) —
    // spacing applies to the Latin part only, and only in the English UI.
    const stampSpacing = isRTL ? 'normal' : '4px'
    w.document.write(
      `<html dir="${isRTL ? 'rtl' : 'ltr'}" lang="${lang}"><head><meta charset="utf-8"><title>${escapeHtml(
        t('pos.receipt'),
      )}</title><style>body{font-family:monospace;font-size:13px;padding:24px;width:320px} .r{display:flex;justify-content:space-between} .dashed{border-top:1px dashed #000;margin:8px 0} h3,p{margin:2px 0;text-align:center} .note{font-size:11px;text-align:${noteAlign};margin:0} .bold{font-weight:bold} .ar{font-size:11px;text-align:${arAlign};direction:rtl;margin:0} .arn{font-weight:bold;direction:rtl;margin:2px 0} .stampline{margin:10px 0;text-align:center} .stamp{font-weight:bold;border:2px solid #047857;color:#047857;display:inline-block;padding:2px 10px;transform:rotate(-6deg)} .stamp .se{letter-spacing:${stampSpacing}} .stamp .sar{direction:rtl} .stamp .sep{letter-spacing:normal} .stampd{font-weight:bold;border:2px solid #7C3AED;color:#7C3AED;display:inline-block;padding:2px 10px;transform:rotate(-6deg)} .stampd .se{letter-spacing:${stampSpacing}} .stampd .sar{direction:rtl} .stampd .sep{letter-spacing:normal}</style></head><body>${html}</body></html>`,
    )
    w.document.close()
    w.focus()
    w.print()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-[380px]">
        <DialogHeader className="sr-only">
          <DialogTitle>
            {t('pos.receipt')} — {t('common.order')} #{order.id}
          </DialogTitle>
        </DialogHeader>

        {/* Thermal-style paper — bilingual EN + AR */}
        <div className="mx-auto w-full max-w-[340px] rounded border bg-white p-6 font-mono text-[13px] leading-tight text-stone-900 shadow-2xl">
          <p className="text-center font-bold uppercase tracking-widest">{restaurantName}</p>
          <p className="text-center font-bold" dir="rtl" lang="ar">
            {restaurantNameAr}
          </p>
          <p className="text-center">{bilingualLabel('pos.salesReceipt')}</p>
          <div className="my-2 border-t border-dashed border-stone-400" />
          <ReceiptRow left={`${bilingualLabel('common.order')} #${model.orderId}`} right={model.tableName} />
          <ReceiptRow left={bilingualLabel('pos.waiter')} right={model.waiter} />
          <ReceiptRow left={bilingualLabel('common.date')} right={model.date} />
          <div className="my-2 border-t border-dashed border-stone-400" />
          {model.items.map((it, i) => (
            <div key={i}>
              <ReceiptRow left={`${it.qty}× ${it.name}`} right={formatCurrency(it.total)} />
              {it.nameAr && (
                <p
                  className="text-left rtl:text-right text-[11px] text-stone-500"
                  dir="rtl"
                  lang="ar"
                >
                  {it.nameAr}
                </p>
              )}
              {it.mods && <p className="ps-3 text-[11px] text-stone-500">+ {it.mods}</p>}
              {it.modsAr && (
                <p
                  className="ps-3 text-left rtl:text-right text-[11px] text-stone-500"
                  dir="rtl"
                  lang="ar"
                >
                  + {it.modsAr}
                </p>
              )}
              {it.notes && <p className="ps-3 text-[11px] text-stone-500">* {it.notes}</p>}
            </div>
          ))}
          <div className="my-2 border-t border-dashed border-stone-400" />
          <ReceiptRow left={bilingualLabel('money.subtotal')} right={formatCurrency(model.subtotal)} />
          {model.discount > 0 && (
            <ReceiptRow left={bilingualLabel('money.discount')} right={`-${formatCurrency(model.discount)}`} />
          )}
          <ReceiptRow left={bilingualLabel('money.tax')} right={formatCurrency(model.tax)} />
          <ReceiptRow left={bilingualLabel('money.serviceTax')} right={formatCurrency(model.serviceTax)} />
          <ReceiptRow left={bilingualLabel('money.total')} right={formatCurrency(model.total)} bold />
          {model.deferred && (
            <>
              <div className="my-3 flex justify-center">
                <span className="inline-flex -rotate-6 items-baseline gap-1.5 rounded border-2 border-[#7C3AED] px-3 py-1 text-sm font-bold text-[#7C3AED]">
                  <span className={isRTL ? undefined : 'tracking-[0.3em]'}>{deferredStamp.en}</span>
                  <span aria-hidden>·</span>
                  <span dir="rtl" lang="ar">
                    {deferredStamp.ar}
                  </span>
                </span>
              </div>
              {model.clientName && (
                <ReceiptRow
                  left={bilingualLabel('pos.deferredClientLabel')}
                  right={model.clientName}
                />
              )}
            </>
          )}
          {model.payments.length > 0 && (
            <>
              <div className="my-2 border-t border-dashed border-stone-400" />
              {model.payments.map((p, i) => (
                <div key={i}>
                  <ReceiptRow left={`- ${p.label}`} right={formatCurrency(p.amount)} />
                  {p.tip > 0 && (
                    <ReceiptRow
                      left={`+ ${bilingualLabel('money.tip')}`}
                      right={formatCurrency(p.tip)}
                    />
                  )}
                </div>
              ))}
              <ReceiptRow left={bilingualLabel('money.paid')} right={formatCurrency(model.paid)} bold />
              {model.tipsTotal > 0 && (
                <>
                  <ReceiptRow
                    left={bilingualLabel('money.tip')}
                    right={formatCurrency(model.tipsTotal)}
                  />
                  <ReceiptRow
                    left={bilingualLabel('money.grandTotal')}
                    right={formatCurrency(model.grandTotal)}
                    bold
                  />
                </>
              )}
              <div className="my-3 flex justify-center">
                <span className="inline-flex -rotate-6 items-baseline gap-1.5 rounded border-2 border-emerald-700 px-3 py-1 text-sm font-bold text-emerald-700">
                  <span className={isRTL ? undefined : 'tracking-[0.3em]'}>{paidStamp.en}</span>
                  <span aria-hidden>·</span>
                  <span dir="rtl" lang="ar">
                    {paidStamp.ar}
                  </span>
                </span>
              </div>
            </>
          )}
          <div className="my-2 border-t border-dashed border-stone-400" />
          <p className="text-center">{bilingualLabel('pos.thankYouReceipt')}</p>
        </div>

        <div className="flex gap-2">
          <Button variant="outline" className="h-11 flex-1 rounded-xl" onClick={handlePrint}>
            <Printer /> {t('common.print')}
          </Button>
          <Button
            className="h-11 flex-1 rounded-xl bg-[#714B67] text-white hover:bg-[#714B67]/90"
            onClick={onClose}
          >
            <Check /> {t('common.done')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ReceiptRow({
  left,
  right,
  bold,
}: {
  left: string
  right: string
  bold?: boolean
}) {
  return (
    <div className={`flex items-baseline gap-1 ${bold ? 'font-bold' : ''}`}>
      <span className="shrink-0">{left}</span>
      <span className="min-w-2 flex-1 border-b border-dotted border-stone-300" aria-hidden />
      <span className="shrink-0 tabular-nums">{right}</span>
    </div>
  )
}
