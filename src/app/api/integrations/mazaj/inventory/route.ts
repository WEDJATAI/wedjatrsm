// /api/integrations/mazaj/inventory — R45 mazaj hookah-platform inventory
// mirror. Mazaj (the hookah ordering platform) PUSHES its current flavor
// availability here; Wedja RSM mirrors it onto the shisha catalog so the
// POS "shows only what is in mazaj inventory":
//
//   POST (x-rsm-key: the SAME delivery webhook key)
//   {
//     "mode": "full" | "delta",          // default full
//     "items": [
//       { "name": "Limon & Mint", "available": true,  "quantity": 12 },
//       { "sku": "SHISHA-2APP",    "available": false }   // quantity<=0 == unavailable
//     ]
//   }
//
//   · Products are matched by productId | sku | name (EN/AR, exact then
//     contains, case-insensitive) — the SAME matching rules as the order
//     webhook, so names that match orders also match inventory.
//   · Matched products flip Product.active (available → active/visible in
//     POS; unavailable → hidden). Every flip rides the hybrid outbox →
//     Neon + every terminal + Turso replica stay in step.
//   · mode "full" (default): shisha-category products NOT mentioned in the
//     push are treated as unavailable (mazaj inventory IS the source of
//     truth). mode "delta": only the pushed items are touched.
//   · Unmatched names are listed in the response — the owner adds the
//     flavor to the Products menu once (with the house price) and every
//     later push matches it.
//   · The pushed snapshot is stored (AppSetting mazajInventory) for the
//     Integrations admin panel.
//
//   GET (admin/settings session): the current snapshot + resolved category
//   scope — used by the Integrations view.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import {
  DELIVERY_WEBHOOK_KEY_SETTING,
  MAZAJ_CATEGORY_NAMES_KEY,
  MAZAJ_DEFAULT_CATEGORY_NAMES,
  MAZAJ_INVENTORY_KEY,
} from '@/lib/constants'
import { emitOutboxEvent } from '@/lib/hybrid-sync/outbox'
import { withWriteLock } from '@/lib/write-mutex'

function keysMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Resolve the shisha category-name scope (setting overrides default). */
async function shishaCategoryNames(): Promise<string[]> {
  const row = await db.appSetting.findUnique({ where: { key: MAZAJ_CATEGORY_NAMES_KEY } })
  const raw = row?.value?.trim() || MAZAJ_DEFAULT_CATEGORY_NAMES
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

type ShishaProduct = {
  id: number
  name: string
  nameAr: string | null
  sku: string | null
  active: boolean
  categoryId: number | null
}

/** The products inside the shisha scope (the gating surface). */
async function shishaProducts(): Promise<{ categoryIds: number[]; products: ShishaProduct[] }> {
  const names = await shishaCategoryNames()
  const cats = await db.category.findMany({ select: { id: true, name: true } })
  const ids = cats.filter((c) => names.includes(c.name.trim().toLowerCase())).map((c) => c.id)
  if (ids.length === 0) return { categoryIds: [], products: [] }
  const products = (await db.product.findMany({
    where: { categoryId: { in: ids } },
    select: { id: true, name: true, nameAr: true, sku: true, active: true, categoryId: true },
  })) as ShishaProduct[]
  return { categoryIds: ids, products }
}

type InvItem = {
  productId?: number
  sku?: string
  name?: string
  available?: boolean
  quantity?: number
}

function snapshotValue(mode: string, items: InvItem[], matchedCount: number, unmatched: string[]): string {
  return JSON.stringify({
    at: new Date().toISOString(),
    mode,
    items: items.map((i) => ({
      name: i.name ?? null,
      sku: i.sku ?? null,
      productId: i.productId ?? null,
      available: i.available ?? (i.quantity != null ? Number(i.quantity) > 0 : null),
      quantity: i.quantity ?? null,
    })),
    matchedCount,
    unmatched,
  })
}

export async function POST(req: NextRequest) {
  try {
    const provided =
      req.headers.get('x-rsm-key') ?? new URL(req.url).searchParams.get('key') ?? ''
    const stored = (await db.appSetting.findUnique({
      where: { key: DELIVERY_WEBHOOK_KEY_SETTING },
    }))?.value
    if (!stored) throw new ApiError('Webhook key is not configured — generate one in Integrations', 503)
    if (!provided || !keysMatch(provided.trim(), stored)) {
      throw new ApiError('Invalid webhook key', 401)
    }

    const body = await req.json().catch(() => {
      throw new ApiError('Invalid JSON body', 400)
    })
    const mode = body?.mode === 'delta' ? 'delta' : 'full'
    if (!Array.isArray(body?.items) || body.items.length === 0) {
      throw new ApiError('items must be a non-empty array', 400)
    }
    if (body.items.length > 500) {
      throw new ApiError('too many items (max 500)', 400)
    }
    const items = body.items as InvItem[]

    const { categoryIds, products } = await shishaProducts()
    if (categoryIds.length === 0) {
      throw new ApiError(
        'No shisha category found — create/rename a category (e.g. "Shisha") or set mazajCategoryNames in Integrations',
        409,
      )
    }

    // matchers (productId > sku > name exact > name contains)
    const byId = new Map(products.map((p) => [p.id, p]))
    const bySku = new Map(products.filter((p) => p.sku).map((p) => [p.sku!.toLowerCase(), p]))
    const byName = new Map<string, ShishaProduct>()
    for (const p of products) {
      byName.set(p.name.trim().toLowerCase(), p)
      if (p.nameAr) byName.set(p.nameAr.trim().toLowerCase(), p)
    }
    const norm = (s: string) => s.trim().toLowerCase()

    const matched = new Map<number, { product: ShishaProduct; available: boolean }>()
    const unmatched: string[] = []
    for (const raw of items) {
      let product: ShishaProduct | undefined
      if (raw.productId != null) product = byId.get(Number(raw.productId))
      if (!product && raw.sku) product = bySku.get(String(raw.sku).toLowerCase())
      if (!product && raw.name) {
        const q = norm(String(raw.name))
        product = byName.get(q)
        if (!product && q.length >= 4) {
          product = products.find(
            (p) => norm(p.name).includes(q) || (p.nameAr ? norm(p.nameAr).includes(q) : false),
          )
        }
      }
      if (!product) {
        unmatched.push(String(raw.name ?? raw.sku ?? raw.productId ?? 'item'))
        continue
      }
      const available =
        typeof raw.available === 'boolean'
          ? raw.available
          : raw.quantity != null
            ? Number(raw.quantity) > 0
            : true
      matched.set(product.id, { product, available })
    }

    // full mode: unmentioned shisha products are unavailable
    const targets = new Map(matched)
    if (mode === 'full') {
      for (const p of products) {
        if (!targets.has(p.id)) targets.set(p.id, { product: p, available: false })
      }
    }

    // apply flips (only when the flag actually changes) + outbox events
    const flippedOn: string[] = []
    const flippedOff: string[] = []
    await withWriteLock(() =>
      db.$transaction(async (tx) => {
        for (const { product, available } of targets.values()) {
          if (product.active === available) continue
          const updated = await tx.product.update({
            where: { id: product.id },
            data: { active: available },
          })
          ;(available ? flippedOn : flippedOff).push(product.name)
          await emitOutboxEvent(tx, {
            entity: 'Product',
            entityId: updated.id,
            operation: 'update',
            row: updated,
          })
        }
        await tx.appSetting.upsert({
          where: { key: MAZAJ_INVENTORY_KEY },
          update: { value: snapshotValue(mode, items, matched.size, unmatched) },
          create: { key: MAZAJ_INVENTORY_KEY, value: snapshotValue(mode, items, matched.size, unmatched) },
        })
      }),
    )

    await logAudit({
      user: null,
      action: 'integration.mazajInventory',
      entity: 'system',
      details: `mazaj inventory push (${mode}) — ${matched.size} matched, ${flippedOn.length} shown (${flippedOn.slice(0, 3).join(', ')}${flippedOn.length > 3 ? '…' : ''}), ${flippedOff.length} hidden${unmatched.length > 0 ? `; unmatched (add to menu): ${unmatched.slice(0, 5).join(', ')}${unmatched.length > 5 ? ` +${unmatched.length - 5}` : ''}` : ''}`,
    })

    return NextResponse.json({
      ok: true,
      mode,
      scopeCategories: categoryIds.length,
      scopeProducts: products.length,
      matched: matched.size,
      shown: flippedOn.length,
      hidden: flippedOff.length,
      unmatched,
      snapshotAt: new Date().toISOString(),
    })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['admin', 'settings'])
    const [snapshotRaw, names] = await Promise.all([
      db.appSetting.findUnique({ where: { key: MAZAJ_INVENTORY_KEY } }),
      shishaCategoryNames(),
    ])
    const { categoryIds, products } = await shishaProducts()
    return NextResponse.json({
      snapshot: snapshotRaw ? JSON.parse(snapshotRaw.value) : null,
      categoryNames: names,
      scopeCategories: categoryIds.length,
      scopeProducts: products.length,
      availableNow: products.filter((p) => p.active).length,
    })
  } catch (err) {
    return errorResponse(err)
  }
}
