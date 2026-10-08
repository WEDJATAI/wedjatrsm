// /api/integrations/delivery/webhook — R13 delivery-aggregator adapter +
// R45 mazaj hookah-platform DINE-IN branch (orders attach to table checks;
// see the mazaj section inside POST below).
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
import { DELIVERY_PROVIDERS, DELIVERY_WEBHOOK_KEY_SETTING, MAZAJ_SEEN_PREFIX } from '@/lib/constants'
import { normalizePersonName } from '@/lib/names'
import { ORDER_INCLUDE, recomputeTotals, serializeOrder } from '@/lib/orders'
import { withWriteLock } from '@/lib/write-mutex'
import { getLocalDevice } from '@/lib/hybrid-sync/device-identity'
import { withOutboxEvents, type OutboxEventInput } from '@/lib/hybrid-sync/outbox'

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

    // ── R45: MAZAJ DINE-IN BRANCH ─────────────────────────────────
    // Mazaj is the in-cafe hookah platform: its orders attach to a TABLE
    // CHECK (the guest is sitting in the cafe), not a delivery envelope.
    //   · table resolved + open check on it → items are ADDED to that
    //     check (one check per table — the cafe model). Idempotency for
    //     this path lives in the AppSetting ledger (mazaj.seen.<ref>) —
    //     Order.externalRef only dedupes NEW-check orders.
    //   · table resolved + no open check → a NEW dine-in check is opened
    //     on the table (externalRef stamped, table flipped to occupied).
    //   · no table info → takeaway fallback (employee handles it from the
    //     order list; there is no check to attach to without a table).
    if (provider === 'mazaj') {
      // Table reference resolution. Table NAMES repeat across floors (three
      // different tables are named "1"), so the only unambiguous reference
      // is the numeric tableId (what the POS button passes as ?tableId=).
      // Name-based refs (table / tableNumber) are accepted ONLY when they
      // resolve to exactly one active table — otherwise 409 with guidance.
      const tableIdRaw = body?.tableId
      const tableRefRaw = body?.table ?? body?.tableNumber ?? null
      let tableRow: { id: number; name: string } | null = null
      if (tableIdRaw != null && tableIdRaw !== '' && Number.isFinite(Number(tableIdRaw))) {
        const byId = await db.restaurantTable.findUnique({
          where: { id: Number(tableIdRaw) },
          include: { floorPlan: { select: { active: true } } },
        })
        if (byId?.active && (byId.floorPlan?.active ?? true)) {
          tableRow = { id: byId.id, name: byId.name }
        }
        if (!tableRow) {
          throw new ApiError(
            `tableId ${Number(tableIdRaw)} not found or not on an active floor (the POS only shows active floors)`,
            404,
          )
        }
      } else if (tableRefRaw != null && tableRefRaw !== '') {
        const refStr = String(tableRefRaw).trim()
        const wanted = refStr.toLowerCase()
        const candidates = (
          await db.restaurantTable.findMany({
            where: { active: true, OR: [{ floorPlan: { active: true } }, { floorPlanId: null }] },
            select: { id: true, name: true },
          })
        ).filter(
          (t) =>
            t.name.trim().toLowerCase() === wanted ||
            t.name.trim().toLowerCase() === `t${wanted}` ||
            (Number.isFinite(Number(refStr)) && t.name.trim().toLowerCase() === `t${refStr.toLowerCase()}`),
        )
        if (candidates.length === 1) {
          tableRow = { id: candidates[0].id, name: candidates[0].name }
        } else if (candidates.length > 1) {
          throw new ApiError(
            `table reference "${refStr.slice(0, 40)}" is ambiguous (${candidates.length} tables share this name across floors: ${candidates.map((c) => `#${c.id} ${c.name}`).join(', ')}) — send the numeric tableId instead (the POS button URL carries it as tableId=…)`,
            409,
          )
        } else {
          throw new ApiError(
            `table not found: "${refStr.slice(0, 40)}" — send the numeric tableId (POS button URL carries it) or the exact table name`,
            404,
          )
        }
      }

      const seenKey = `${MAZAJ_SEEN_PREFIX}${provider}:${externalId}`
      const seenRow = await db.appSetting.findUnique({ where: { key: seenKey } })
      if (seenRow) {
        // replay of an already-applied add-to-check delivery — return the
        // CURRENT state of the check it landed on (same contract as the
        // externalRef replay above, but the ledger knows the order id).
        const seen = JSON.parse(seenRow.value) as { orderId?: number }
        if (seen.orderId != null) {
          const existing = await db.order.findUnique({
            where: { id: seen.orderId },
            include: ORDER_INCLUDE,
          })
          if (existing) {
            return NextResponse.json({
              order: serializeOrder(existing),
              duplicate: true,
              addedToCheck: true,
              table: tableRow?.name ?? null,
              unmatched: [],
              priceDifferences: [],
            })
          }
        }
      }

      const localDevice = await getLocalDevice()

      // ── case 1: open check on the table → ADD items to it ──
      const openOrder = tableRow
        ? await db.order.findFirst({
            where: { tableId: tableRow.id, status: 'open' },
            orderBy: { id: 'desc' },
          })
        : null

      if (openOrder) {
        const order = await withWriteLock(() =>
          db.$transaction(
            async (tx) => {
              const lastItem = await tx.orderItem.findFirst({
                where: { orderId: openOrder.id },
                orderBy: { id: 'desc' },
                select: { id: true },
              })
              const maxItemId = lastItem?.id ?? 0
              await tx.orderItem.createMany({
                data: matched.map((m) => ({
                  orderId: openOrder.id,
                  productId: m.productId,
                  quantity: m.quantity,
                  unitPrice: m.unitPrice,
                  notes: m.notes,
                  status: 'new',
                  course: 'main',
                })),
              })
              const createdItems = await tx.orderItem.findMany({
                where: { orderId: openOrder.id, id: { gt: maxItemId } },
              })
              const events: OutboxEventInput[] = createdItems.map((item) => ({
                entity: 'OrderItem',
                entityId: item.id,
                operation: 'create' as const,
                row: item,
              }))
              const orderRow = await tx.order.findUnique({ where: { id: openOrder.id } })
              if (orderRow) {
                events.push({
                  entity: 'Order',
                  entityId: openOrder.id,
                  operation: 'update',
                  row: orderRow,
                })
              }
              await withOutboxEvents(tx, events)
              await tx.appSetting.upsert({
                where: { key: seenKey },
                update: { value: JSON.stringify({ orderId: openOrder.id, itemIds: createdItems.map((i) => i.id), at: new Date().toISOString() }) },
                create: { key: seenKey, value: JSON.stringify({ orderId: openOrder.id, itemIds: createdItems.map((i) => i.id), at: new Date().toISOString() }) },
              })
              return recomputeTotals(openOrder.id, tx)
            },
            { timeout: 30_000, maxWait: 15_000 },
          ),
        )
        await logAudit({
          user: null,
          action: 'integration.webhook',
          entity: 'order',
          entityId: order.id,
          details: `mazaj hookah order ${externalId} → ADDED to check #${order.id} (table ${tableRow!.name}, ${customerName}) — EGP ${order.totalAmount.toFixed(2)}, ${matched.length} item(s)${unmatched.length > 0 ? `; unmatched skipped: ${unmatched.slice(0, 3).join(', ')}` : ''}`,
        })
        const fresh = await db.order.findUniqueOrThrow({
          where: { id: order.id },
          include: ORDER_INCLUDE,
        })
        return NextResponse.json(
          {
            order: serializeOrder(fresh),
            duplicate: false,
            addedToCheck: true,
            table: tableRow!.name,
            unmatched,
            priceDifferences: priceDiffs,
          },
          { status: 201 },
        )
      }

      // ── case 2/3: no open check → NEW order (dine-in on the table, or
      // takeaway fallback when mazaj sent no table reference) ──
      const order = await withWriteLock(() =>
        db.$transaction(
          async (tx) => {
            const created = await tx.order.create({
              data: {
                orderType: tableRow ? 'dinein' : 'takeaway',
                tableId: tableRow?.id ?? null,
                clientName: customerName,
                externalRef,
                originDeviceId: localDevice?.deviceId ?? null,
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
            const createdItems = await tx.orderItem.findMany({ where: { orderId: created.id } })
            const events: OutboxEventInput[] = [
              { entity: 'Order', entityId: created.id, operation: 'create', row: created },
              ...createdItems.map((item) => ({
                entity: 'OrderItem',
                entityId: item.id,
                operation: 'create' as const,
                row: item,
              })),
            ]
            if (tableRow) {
              const updatedTable = await tx.restaurantTable.update({
                where: { id: tableRow.id },
                data: { status: 'occupied' },
              })
              events.push({
                entity: 'RestaurantTable',
                entityId: updatedTable.id,
                operation: 'update',
                row: updatedTable,
              })
            }
            await withOutboxEvents(tx, events)
            return recomputeTotals(created.id, tx)
          },
          { timeout: 30_000, maxWait: 15_000 },
        ),
      )
      await logAudit({
        user: null,
        action: 'integration.webhook',
        entity: 'order',
        entityId: order.id,
        details: `mazaj hookah order ${externalId} → NEW ${tableRow ? `dine-in check #${order.id} on table ${tableRow.name}` : 'takeaway order (no table sent)'} (${customerName}) — EGP ${order.totalAmount.toFixed(2)}, ${matched.length} item(s)${unmatched.length > 0 ? `; unmatched skipped: ${unmatched.slice(0, 3).join(', ')}` : ''}`,
      })
      const fresh = await db.order.findUniqueOrThrow({
        where: { id: order.id },
        include: ORDER_INCLUDE,
      })
      return NextResponse.json(
        {
          order: serializeOrder(fresh),
          duplicate: false,
          addedToCheck: false,
          table: tableRow?.name ?? null,
          unmatched,
          priceDifferences: priceDiffs,
        },
        { status: 201 },
      )
    }

    // ── create the delivery order (no session — system actor) ──
    // r31 audit fix: create + totals in ONE transaction (same zombie-order
    // class fixed in POST /api/orders — no second tx that can strand a
    // committed order with totalAmount = 0 under write contention).
    // R39 hybrid sync: delivery orders ride the SAME outbox contract as POS
    // creates — Order create + every OrderItem create + the origin stamp
    // (previously the order synced only via the recomputeTotals update event,
    // leaving remote terminals showing itemless delivery checks and without
    // the origin-authority lock; r39 audit finding).
    const localDevice = await getLocalDevice()
    const order = await withWriteLock(() =>
      db.$transaction(async (tx) => {
      const created = await tx.order.create({
        data: {
          orderType: 'delivery',
          deliveryPhone: customerPhone,
          deliveryAddress: address,
          clientName: customerName,
          externalRef,
          originDeviceId: localDevice?.deviceId ?? null,
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
      const createdItems = await tx.orderItem.findMany({ where: { orderId: created.id } })
      const events: OutboxEventInput[] = [
        { entity: 'Order', entityId: created.id, operation: 'create', row: created },
        ...createdItems.map((item) => ({
          entity: 'OrderItem',
          entityId: item.id,
          operation: 'create' as const,
          row: item,
        })),
      ]
      await withOutboxEvents(tx, events)
      return recomputeTotals(created.id, tx)
    }, {
      // r31: same write-contention fix as POST /api/orders (see there).
      timeout: 30_000,
      maxWait: 15_000,
    }),
    )

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
