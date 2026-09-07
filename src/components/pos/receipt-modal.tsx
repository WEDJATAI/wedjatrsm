'use client'

import { Check, Printer } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { TAX_RATE } from '@/lib/constants'
import { formatCurrency, formatDateTime, formatQty } from '@/lib/format'
import { useI18n } from '@/lib/i18n'
import { useAppSettings } from '@/lib/use-settings'
import type { Order } from '@/lib/types'
import { escapeHtml, round2 } from './pos-utils'

type ReceiptModalProps = {
  order: Order
  open: boolean
  onOpenChange: (open: boolean) => void
  onClose: () => void
}

type TFunc = (key: string, vars?: Record<string, string | number>) => string

type ReceiptModel = {
  orderId: number
  tableName: string
  waiter: string
  date: string
  items: { qty: string; name: string; total: number; notes: string | null }[]
  subtotal: number
  discount: number
  taxLabel: string
  tax: number
  total: number
  payments: { label: string; amount: number }[]
  paid: number
}

function buildReceiptModel(order: Order, t: TFunc): ReceiptModel {
  return {
    orderId: order.id,
    tableName: order.table?.name ?? t('common.takeaway'),
    waiter: order.user?.name ?? '—',
    date: formatDateTime(order.createdAt),
    items: order.items.map((it) => ({
      qty: formatQty(it.quantity),
      name: it.product?.name ?? t('pos.item'),
      total: round2(it.quantity * it.unitPrice),
      notes: it.notes,
    })),
    subtotal: round2(order.subtotalAmount),
    discount: round2(order.discountAmount),
    taxLabel: t('money.tax'),
    tax: round2(order.taxAmount),
    total: round2(order.totalAmount),
    payments: order.payments.map((p) => ({
      label: `${t(`status.payment.${p.method}`)}${p.reference ? ` (${p.reference})` : ''}`,
      amount: round2(p.amount),
    })),
    paid: round2(order.paidAmount),
  }
}

function buildReceiptHtml(m: ReceiptModel, t: TFunc, restaurantName: string): string {
  const row = (l: string, r: string, cls = '') =>
    `<div class="r ${cls}"><span>${escapeHtml(l)}</span><span>${escapeHtml(r)}</span></div>`
  const dashed = '<div class="dashed"></div>'
  const stamp = `<p class="stampline"><span class="stamp">${escapeHtml(t('pos.paidStamp'))}</span></p>`
  const lines: string[] = []
  lines.push(`<h3>${escapeHtml(restaurantName)}</h3>`)
  lines.push(`<p>${escapeHtml(t('pos.salesReceipt'))}</p>`)
  lines.push(dashed)
  lines.push(row(`${t('common.order')} #${m.orderId}`, m.tableName))
  lines.push(row(t('pos.waiter'), m.waiter))
  lines.push(row(t('common.date'), m.date))
  lines.push(dashed)
  for (const it of m.items) {
    lines.push(row(`${it.qty}× ${it.name}`, formatCurrency(it.total)))
    if (it.notes) lines.push(`<p class="note">  * ${escapeHtml(it.notes)}</p>`)
  }
  lines.push(dashed)
  lines.push(row(t('money.subtotal'), formatCurrency(m.subtotal)))
  if (m.discount > 0) lines.push(row(t('money.discount'), `-${formatCurrency(m.discount)}`))
  lines.push(row(m.taxLabel, formatCurrency(m.tax)))
  lines.push(row(t('money.total'), formatCurrency(m.total), 'bold'))
  if (m.payments.length > 0) {
    lines.push(dashed)
    for (const p of m.payments) lines.push(row(`- ${p.label}`, formatCurrency(p.amount)))
    lines.push(row(t('money.paid'), formatCurrency(m.paid), 'bold'))
    lines.push(stamp)
  }
  lines.push(dashed)
  lines.push(`<p>${escapeHtml(t('pos.thankYouReceipt'))}</p>`)
  return lines.join('\n')
}

export default function ReceiptModal({ order, open, onOpenChange, onClose }: ReceiptModalProps) {
  const { t, lang, isRTL } = useI18n()
  const { restaurantName } = useAppSettings()
  const model = buildReceiptModel(order, t)

  const handlePrint = () => {
    const html = buildReceiptHtml(model, t, restaurantName)
    const w = window.open('', '_blank', 'width=380,height=640')
    if (!w) {
      window.alert(t('pos.receiptPopupBlocked'))
      return
    }
    const noteAlign = isRTL ? 'right' : 'left'
    // Arabic stamps don't get letter-spacing (it breaks joined letters).
    const stampSpacing = isRTL ? 'normal' : '4px'
    w.document.write(
      `<html dir="${isRTL ? 'rtl' : 'ltr'}" lang="${lang}"><head><title>${escapeHtml(
        t('pos.receipt'),
      )}</title><style>body{font-family:monospace;font-size:13px;padding:24px;width:320px} .r{display:flex;justify-content:space-between} .dashed{border-top:1px dashed #000;margin:8px 0} h3,p{margin:2px 0;text-align:center} .note{font-size:11px;text-align:${noteAlign};margin:0} .bold{font-weight:bold} .stampline{margin:10px 0;text-align:center} .stamp{font-weight:bold;letter-spacing:${stampSpacing};border:2px solid #047857;color:#047857;display:inline-block;padding:2px 10px;transform:rotate(-6deg)}</style></head><body>${html}</body></html>`,
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

        {/* Thermal-style paper */}
        <div className="mx-auto w-full max-w-[340px] rounded border bg-white p-6 font-mono text-[13px] leading-tight text-stone-900 shadow-2xl">
          <p className="text-center font-bold uppercase tracking-widest">{restaurantName}</p>
          <p className="text-center">{t('pos.salesReceipt')}</p>
          <div className="my-2 border-t border-dashed border-stone-400" />
          <ReceiptRow left={`${t('common.order')} #${model.orderId}`} right={model.tableName} />
          <ReceiptRow left={t('pos.waiter')} right={model.waiter} />
          <ReceiptRow left={t('common.date')} right={model.date} />
          <div className="my-2 border-t border-dashed border-stone-400" />
          {model.items.map((it, i) => (
            <div key={i}>
              <ReceiptRow left={`${it.qty}× ${it.name}`} right={formatCurrency(it.total)} />
              {it.notes && <p className="ps-3 text-[11px] text-stone-500">* {it.notes}</p>}
            </div>
          ))}
          <div className="my-2 border-t border-dashed border-stone-400" />
          <ReceiptRow left={t('money.subtotal')} right={formatCurrency(model.subtotal)} />
          {model.discount > 0 && (
            <ReceiptRow left={t('money.discount')} right={`-${formatCurrency(model.discount)}`} />
          )}
          <ReceiptRow left={model.taxLabel} right={formatCurrency(model.tax)} />
          <ReceiptRow left={t('money.total')} right={formatCurrency(model.total)} bold />
          {model.payments.length > 0 && (
            <>
              <div className="my-2 border-t border-dashed border-stone-400" />
              {model.payments.map((p, i) => (
                <ReceiptRow key={i} left={`- ${p.label}`} right={formatCurrency(p.amount)} />
              ))}
              <ReceiptRow left={t('money.paid')} right={formatCurrency(model.paid)} bold />
              <div className="my-3 flex justify-center">
                <span
                  className={`-rotate-6 rounded border-2 border-emerald-700 px-3 py-1 text-sm font-bold text-emerald-700 ${
                    isRTL ? '' : 'tracking-[0.3em]'
                  }`}
                >
                  {t('pos.paidStamp')}
                </span>
              </div>
            </>
          )}
          <div className="my-2 border-t border-dashed border-stone-400" />
          <p className="text-center">{t('pos.thankYouReceipt')}</p>
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
