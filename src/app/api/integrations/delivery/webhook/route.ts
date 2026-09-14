// /api/integrations/delivery/webhook — R13 delivery-aggregator adapter.
//
// Unauthenticated-by-session, authenticated-by-key: aggregators (Talabat,
// Elmenus, … or any middleware) POST new delivery orders here with
//   x-rsm-key: <deliveryWebhookKey AppSetting>
//
// Idempotent per (provider, externalId) via Order.externalRef — replays
// return the ORIGINAL order with duplicate: true.
//
// Items are matched against OUR menu by productId | sku | name (EN/AR,
// case-insensitive) so pricing/inventory/reports always use our catalog.
// Requests with ZERO matched items are rejected (422) with the unmatched
// names listed — the aggregator's mapping needs fixing first.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { errorResponse, ApiError } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { DELIVERY_PROVIDERS, DELIVERY_WEBHOOK_KEY_SETTING } from '@/lib/constants'
import { normalizePersonName } from '@/lib/names'
import { ORDER_INCLUDE, recomputeTotals, serializeOrder } from '@/lib/orders'

type WebhookItem = {
  productId?: number
  sku?: string
  name?: string
  quantity: number
  notes?: string
  unitPrice?: number // ignored for pricing — recorded in the audit trail only
}

/** timing-safe-ish string compare (both sides same length after trim). */
function keysMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export async function POST(req: NextRequest) {
  try {
    // ── key auth (header takes precedence; query param allowed for
    // aggregators that cannot set headers) ──
    const provided =
      req.headers.get('x-rsm-key') ?? new URL(req.url).searchParams.get('key') ?? ''
    const stored = (await db.appSetting.findUnique({
      where: { key: DELIVERY_WEBHOOK_KEY_SETTING },
    }))?.value
    if (!stored) {
      throw new ApiError('Webhook is not configured — generate a key in Integrations', 503)
    }
    if (!provided || !keysMatch(provided.trim(), stored)) {
      throw new ApiError('Invalid webhook key', 401)
    }

    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })

    // ── validate envelope ──
    const provider = String(body?.provider ?? 'generic').trim().toLowerCase()
    if (!(DELIVERY_PROVIDERS as readonly string[]).includes(provider)) {
      throw new ApiError(`provider must be one of: ${DELIVERY_PROVIDERS.join(', ')}`, 400)
    }
    const externalId = String(body?.externalId ?? '').trim()
    if (!externalId || externalId.length > 80) {
      throw new ApiError('externalId is required (1-80 characters)', 400)
    }
    const customerName = normalizePersonName(String(body?.customerName ?? ''))
    if (!customerName || customerName.length > 60) {
      throw new ApiError('customerName is required (1-60 characters)', 400)
    }
    const customerPhone = String(body?.customerPhone ?? '').trim() || null
    if (customerPhone && customerPhone.length > 20) {
      throw new ApiError('customerPhone is too long (max 20 characters)', 400)
    }
    const address = String(body?.address ?? '').trim() || null
    if (address && address.length > 200) {
      throw new ApiError('address is too long (max 200 characters)', 400)
    }
    const notes = String(body?.notes ?? '').trim() || null
    if (notes && notes.length > 300) {
      throw new ApiError('notes are too long (max 300 characters)', 400)
    }
    if (!Array.isArray(body?.items) || body.items.length === 0) {
      throw new ApiError('items must be a non-empty array', 400)
    }
    if (body.items.length > 60) {
      throw new ApiError('too many items (max 60)', 400)
    }

    // ── idempotency: replay returns the original order ──
    const externalRef = `${provider}:${externalId}`
    const replay = await db.order.findUnique({
      where: { externalRef },
      include: ORDER_INCLUDE,
    })
    if (replay) {
      return NextResponse.json({ order: serializeOrder(replay), duplicate: true })
    }

    // ── match items against OUR menu ──
    const catalog = await db.product.findMany({
      where: { active: true, isSellable: true },
      select: { id: true, name: true, nameAr: true, sku: true, price: true },
    })
    const byId = new Map(catalog.map((p) => [p.id, p]))
    const bySku = new Map(catalog.filter((p) => p.sku).map((p) => [p.sku!.toLowerCase(), p]))
    const byName = new Map<string, typeof catalog[number]>()
    for (const p of catalog) {
      byName.set(p.name.toLowerCase(), p)
      if (p.nameAr) byName.set(p.nameAr.trim().toLowerCase(), p)
    }

    const unmatched: string[] = []
    const matched: { productId: number; quantity: number; unitPrice: number; notes: string | null }[] = []
    const priceDiffs: string[] = []

    // Second-pass fuzzy matcher: aggregators typically send short display
    // names ("Koshari") vs our full menu names ("Koshari (Classic)").
    // Bidirectional contains-match on the normalized names, minimum length
    // so tiny strings never fuzzy-match. Exact matches above always win.
    const fuzzyFind = (query: string): typeof catalog[number] | undefined => {
      const q = query.trim().toLowerCase()
      if (q.length < 4) return undefined
      for (const p of catalog) {
        const names = [p.name.toLowerCase()]
        if (p.nameAr) names.push(p.nameAr.trim().toLowerCase())
        for (const name of names) {
          if (name.includes(q) || q.includes(name)) return p
        }
      }
      return undefined
    }

    for (const raw of body.items as WebhookItem[]) {
      const quantity = Number(raw?.quantity)
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 100) {
        throw new ApiError('item quantity must be between 0 and 100', 400)
      }
      let product: typeof catalog[number] | undefined
      if (raw.productId != null) {
        product = byId.get(Number(raw.productId))
      }
      if (!product && raw.sku) {
        product = bySku.get(String(raw.sku).toLowerCase())
      }
      if (!product && raw.name) {
        const exact = String(raw.name).trim().toLowerCase()
        product = byName.get(exact) ?? fuzzyFind(exact)
      }
      if (!product) {
        unmatched.push(String(raw.name ?? raw.sku ?? raw.productId ?? 'item'))
        continue
      }
      const itemNotes = raw.notes ? String(raw.notes).trim().slice(0, 200) : null
      matched.push({ productId: product.id, quantity, unitPrice: product.price, notes: itemNotes })
      if (raw.unitPrice != null && Number.isFinite(Number(raw.unitPrice))) {
        const requested = Math.round(Number(raw.unitPrice) * 100) / 100
        if (Math.abs(requested - product.price) > 0.02) {
          priceDiffs.push(
            `${product.name}: platform EGP ${requested.toFixed(2)} vs menu EGP ${product.price.toFixed(2)}`,
          )
        }
      }
    }

    if (matched.length === 0) {
      throw new ApiError(
        `No items matched the menu. Unmatched: ${unmatched.slice(0, 5).join(', ')}${
          unmatched.length > 5 ? ` (+${unmatched.length - 5} more)` : ''
        }`,
        422,
      )
    }

    // ── create the delivery order (no session — system actor) ──
    const created = await db.order.create({
      data: {
        orderType: 'delivery',
        deliveryPhone: customerPhone,
        deliveryAddress: address,
        clientName: customerName,
        externalRef,
        guests: 1,
        items: {
          create: matched.map((m) => ({
            productId: m.productId,
            quantity: m.quantity,
            unitPrice: m.unitPrice,
            notes: m.notes,
            status: 'new',
            course: 'main',
          })),
        },
      },
    })
    const order = await recomputeTotals(created.id)

    await logAudit({
      user: null,
      action: 'integration.webhook',
      entity: 'order',
      entityId: order.id,
      details: `${provider} delivery order ${externalId} → order #${order.id} (${customerName}${
        customerPhone ? `, ${customerPhone}` : ''
      }) — EGP ${order.totalAmount.toFixed(2)}, ${matched.length} item(s)${
        unmatched.length > 0
          ? `; unmatched skipped: ${unmatched.slice(0, 3).join(', ')}${unmatched.length > 3 ? ` +${unmatched.length - 3}` : ''}`
          : ''
      }${priceDiffs.length > 0 ? `; price diffs: ${priceDiffs.join('; ')}` : ''}`,
    })

    const fresh = await db.order.findUniqueOrThrow({
      where: { id: order.id },
      include: ORDER_INCLUDE,
    })
    return NextResponse.json(
      {
        order: serializeOrder(fresh),
        duplicate: false,
        unmatched,
        priceDifferences: priceDiffs,
      },
      { status: 201 },
    )
  } catch (err) {
    return errorResponse(err)
  }
}
