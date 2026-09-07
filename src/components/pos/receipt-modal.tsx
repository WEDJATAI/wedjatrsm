'use client'

import { Check, Printer } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { PAYMENT_METHOD_LABELS, RESTAURANT_NAME, TAX_RATE } from '@/lib/constants'
import { formatCurrency, formatDateTime, formatQty } from '@/lib/format'
import type { Order } from '@/lib/types'
import { round2 } from './pos-utils'

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
  items: { qty: string; name: string; total: number; notes: string | null }[]
  subtotal: number
  discount: number
  taxLabel: string
  tax: number
  total: number
  payments: { label: string; amount: number }[]
  paid: number
}

function buildReceiptModel(order: Order): ReceiptModel {
  return {
    orderId: order.id,
    tableName: order.table?.name ?? 'Takeaway',
    waiter: order.user?.name ?? '—',
    date: formatDateTime(order.createdAt),
    items: order.items.map((it) => ({
      qty: formatQty(it.quantity),
      name: it.product?.name ?? 'Item',
      total: round2(it.quantity * it.unitPrice),
      notes: it.notes,
    })),
    subtotal: round2(order.subtotalAmount),
    discount: round2(order.discountAmount),
    taxLabel: `VAT ${Math.round(TAX_RATE * 100)}%`,
    tax: round2(order.taxAmount),
    total: round2(order.totalAmount),
    payments: order.payments.map((p) => ({
      label: `${PAYMENT_METHOD_LABELS[p.method] ?? p.method}${p.reference ? ` (${p.reference})` : ''}`,
      amount: round2(p.amount),
    })),
    paid: round2(order.paidAmount),
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function buildReceiptHtml(m: ReceiptModel): string {
  const row = (l: string, r: string, cls = '') =>
    `<div class="r ${cls}"><span>${esc(l)}</span><span>${esc(r)}</span></div>`
  const dashed = '<div class="dashed"></div>'
  const lines: string[] = []
  lines.push(`<h3>${esc(RESTAURANT_NAME)}</h3>`)
  lines.push('<p>SALES RECEIPT</p>')
  lines.push(dashed)
  lines.push(row(`Order #${m.orderId}`, m.tableName))
  lines.push(row('Waiter', m.waiter))
  lines.push(row('Date', m.date))
  lines.push(dashed)
  for (const it of m.items) {
    lines.push(row(`${it.qty}× ${it.name}`, formatCurrency(it.total)))
    if (it.notes) lines.push(`<p class="note">  * ${esc(it.notes)}</p>`)
  }
  lines.push(dashed)
  lines.push(row('Subtotal', formatCurrency(m.subtotal)))
  if (m.discount > 0) lines.push(row('Discount', `-${formatCurrency(m.discount)}`))
  lines.push(row(m.taxLabel, formatCurrency(m.tax)))
  lines.push(row('TOTAL', formatCurrency(m.total), 'bold'))
  if (m.payments.length > 0) {
    lines.push(dashed)
    for (const p of m.payments) lines.push(row(`- ${p.label}`, formatCurrency(p.amount)))
    lines.push(row('PAID', formatCurrency(m.paid), 'bold'))
  }
  lines.push(dashed)
  lines.push('<p>Thank you — please come again!</p>')
  return lines.join('\n')
}

export default function ReceiptModal({ order, open, onOpenChange, onClose }: ReceiptModalProps) {
  const model = buildReceiptModel(order)

  const handlePrint = () => {
    const html = buildReceiptHtml(model)
    const w = window.open('', '_blank', 'width=380,height=640')
    if (!w) {
      window.alert('Please allow pop-ups to print the receipt.')
      return
    }
    w.document.write(
      `<html><head><title>Receipt</title><style>body{font-family:monospace;font-size:13px;padding:24px;width:320px} .r{display:flex;justify-content:space-between} .dashed{border-top:1px dashed #000;margin:8px 0} h3,p{margin:2px 0;text-align:center} .note{font-size:11px;text-align:left;margin:0} .bold{font-weight:bold}</style></head><body>${html}</body></html>`,
    )
    w.document.close()
    w.focus()
    w.print()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-[380px]">
        <DialogHeader className="sr-only">
          <DialogTitle>Receipt — Order #{order.id}</DialogTitle>
        </DialogHeader>

        {/* Thermal-style paper */}
        <div className="mx-auto w-full max-w-[340px] rounded border bg-white p-6 font-mono text-[13px] leading-tight text-stone-900 shadow-2xl">
          <p className="text-center font-bold uppercase tracking-widest">{RESTAURANT_NAME}</p>
          <p className="text-center">SALES RECEIPT</p>
          <div className="my-2 border-t border-dashed border-stone-400" />
          <ReceiptRow left={`Order #${model.orderId}`} right={model.tableName} />
          <ReceiptRow left="Waiter" right={model.waiter} />
          <ReceiptRow left="Date" right={model.date} />
          <div className="my-2 border-t border-dashed border-stone-400" />
          {model.items.map((it, i) => (
            <div key={i}>
              <ReceiptRow left={`${it.qty}× ${it.name}`} right={formatCurrency(it.total)} />
              {it.notes && <p className="pl-3 text-[11px] text-stone-500">* {it.notes}</p>}
            </div>
          ))}
          <div className="my-2 border-t border-dashed border-stone-400" />
          <ReceiptRow left="Subtotal" right={formatCurrency(model.subtotal)} />
          {model.discount > 0 && (
            <ReceiptRow left="Discount" right={`-${formatCurrency(model.discount)}`} />
          )}
          <ReceiptRow left={model.taxLabel} right={formatCurrency(model.tax)} />
          <ReceiptRow left="TOTAL" right={formatCurrency(model.total)} bold />
          {model.payments.length > 0 && (
            <>
              <div className="my-2 border-t border-dashed border-stone-400" />
              {model.payments.map((p, i) => (
                <ReceiptRow key={i} left={`- ${p.label}`} right={formatCurrency(p.amount)} />
              ))}
              <ReceiptRow left="PAID" right={formatCurrency(model.paid)} bold />
            </>
          )}
          <div className="my-2 border-t border-dashed border-stone-400" />
          <p className="text-center">Thank you — please come again!</p>
        </div>

        <div className="flex gap-2">
          <Button variant="outline" className="h-11 flex-1" onClick={handlePrint}>
            <Printer /> Print
          </Button>
          <Button className="h-11 flex-1" onClick={onClose}>
            <Check /> Done
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
