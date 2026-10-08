// /api/invoices — R13 ETA (Egyptian Tax Authority) e-invoice export.
// GET (admin/reports): closed (paid) orders in a date range rendered as
// submission-ready invoice documents (UUID + taxpayer identity + line-level
// tax breakdown). This is an EXPORT adapter: production submission to the
// ETA portal requires provider certification — the JSON structure here
// follows the documented document shape so an integrator can submit as-is.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { errorResponse, requireAuth, ApiError } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { ETA_ADDRESS_KEY, ETA_REG_NUMBER_KEY, RESTAURANT_NAME, TAX_RATE } from '@/lib/constants'

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** RFC 4122 v4 UUID (crypto-random) — one per invoice export. */
function uuidv4(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireAuth(req, ['admin', 'reports', 'settings'])
    const { searchParams } = new URL(req.url)

    const toParam = searchParams.get('to')
    const fromParam = searchParams.get('from')
    let from: Date
    let to: Date
    try {
      from = fromParam ? new Date(fromParam) : new Date(Date.now() - 7 * 24 * 3600 * 1000)
      to = toParam ? new Date(toParam) : new Date()
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new Error('bad date')
    } catch {
      throw new ApiError('Invalid from/to datetime', 400)
    }
    if (from >= to) throw new ApiError('"from" must be before "to"', 400)

    // issuer identity (taxpayer fields from Integrations, name from settings)
    const [etaReg, etaAddress, nameRow] = await Promise.all([
      db.appSetting.findUnique({ where: { key: ETA_REG_NUMBER_KEY } }),
      db.appSetting.findUnique({ where: { key: ETA_ADDRESS_KEY } }),
      db.appSetting.findUnique({ where: { key: 'restaurantName' } }),
    ])
    const issuer = {
      name: nameRow?.value ?? RESTAURANT_NAME,
      registrationNumber: etaReg?.value ?? '',
      address: etaAddress?.value ?? '',
      // tax authority code — Egypt ETA production value; configurable later
      country: 'EG',
    }

    const orders = await db.order.findMany({
      where: {
        status: 'paid',
        closedAt: { gte: from, lte: to },
      },
      orderBy: { closedAt: 'asc' },
      include: {
        items: { include: { product: { select: { name: true, nameAr: true } } } },
        payments: true,
        customer: { select: { id: true, name: true, phone: true } },
      },
      take: 500,
    })

    const invoices = orders.map((order) => {
      // NOTE on tax math (mirrors recomputeTotals in lib/orders): item unit
      // prices are NET of tax; the 14% VAT and 12% service tax are computed
      // on the discounted base at the ORDER level. For the ETA document the
      // order-level discount is prorated across lines so Σ line net/tax
      // reconciles with the order totals.
      const subtotal = order.subtotalAmount
      const discount = order.discountAmount
      const lines = order.items.map((it, index) => {
        const gross = round2(it.quantity * it.unitPrice)
        const share = subtotal > 0 ? gross / subtotal : 0
        const netAmount = round2(gross - discount * share)
        const taxAmount = round2(netAmount * TAX_RATE)
        return {
          lineNumber: index + 1,
          description: it.product?.name ?? 'Item',
          descriptionAr: it.product?.nameAr ?? null,
          quantity: it.quantity,
          unitPrice: round2(it.unitPrice),
          netAmount,
          taxRate: TAX_RATE,
          taxAmount,
          total: round2(netAmount + taxAmount),
        }
      })
      const netTotal = round2(lines.reduce((s, l) => s + l.netAmount, 0))
      const taxTotal = round2(lines.reduce((s, l) => s + l.taxAmount, 0))
      const methodTotals = order.payments.reduce<Record<string, number>>((acc, p) => {
        acc[p.method] = round2((acc[p.method] ?? 0) + p.amount)
        return acc
      }, {})
      return {
        uuid: uuidv4(),
        internalId: `ORDER-${order.id}`,
        type: 'I', // invoice
        issueDate: order.closedAt ? order.closedAt.toISOString() : order.createdAt.toISOString(),
        issuer,
        receiver: {
          type: order.customerId != null ? 'P' : 'B', // person / business(anonymous)
          name: order.customer?.name ?? order.clientName ?? 'Walk-in customer',
          phone: order.customer?.phone ?? order.deliveryPhone ?? null,
          address: order.deliveryAddress ?? null,
        },
        orderKind: order.orderType, // dinein | takeaway | delivery
        lines,
        totals: {
          netAmount: netTotal,
          taxAmount: taxTotal,
          serviceTaxAmount: round2(order.serviceTaxAmount),
          discountAmount: round2(order.discountAmount),
          totalAmount: round2(order.totalAmount),
        },
        paymentBreakdown: Object.entries(methodTotals).map(([method, amount]) => ({
          method,
          amount,
        })),
        pointsRedeemed: round2(order.pointsRedeemed),
        pointsEarned: round2(order.pointsEarned),
      }
    })

    await logAudit({
      user,
      action: 'invoice.export',
      entity: 'invoice',
      entityId: null,
      details: `Exported ${invoices.length} e-invoice document(s) for ${from.toISOString()} → ${to.toISOString()}`,
    })

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      range: { from: from.toISOString(), to: to.toISOString() },
      currency: 'EGP',
      issuer,
      count: invoices.length,
      totals: {
        netAmount: round2(invoices.reduce((s, i) => s + i.totals.netAmount, 0)),
        taxAmount: round2(invoices.reduce((s, i) => s + i.totals.taxAmount, 0)),
        totalAmount: round2(invoices.reduce((s, i) => s + i.totals.totalAmount, 0)),
      },
      invoices,
    })
  } catch (err) {
    return errorResponse(err)
  }
}
