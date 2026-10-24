// /api/integrations/mazaj/catalog — R46 mazaj hookah-platform CATALOG sync
// (types + prices). Mazaj (the hookah ordering platform) is the source of
// truth for the shisha menu: it pushes its brand×type price matrix here and
// Wedjat RSM mirrors it onto the shisha categories so the POS check always
// prices shisha lines with the SAME prices the mazaj platform charges.
//
//   POST (x-rsm-key: the SAME delivery webhook key)
//   {
//     "products": [
//       { "sku": "MAZAJ-MAZAYA-FRUITS", "name": "Mazaya Fruits",
//         "nameAr": "شيشة مازايا فواكه", "price": 125, "active": true },
//       { "sku": "MAZAJ-AMY-MIX", "name": "Amy Fruits Mix", "price": 180 }
//     ]
//   }
//
//   · SKUs are namespaced to the integration: they MUST start with the
//     MAZAJ- prefix (see MAZAJ_SKU_PREFIX). Only products inside that
//     namespace are created/updated/deactivated here — the owner's own
//     manually-created shisha products are NEVER touched by this endpoint
//     (their availability is governed by the R45 inventory push instead).
//   · Match by SKU (case-insensitive). Missing → CREATED in the first
//     shisha-scope category (isSellable, so checks/KDS see it). Found →
//     name / nameAr / price / active updated ONLY when actually changed.
//   · Managed products (MAZAJ-* SKU) in scope but ABSENT from the push are
//     deactivated (the platform stopped selling that type). Never deleted —
//     history (order items, reports) keeps referencing them.
//   · Every mutation rides the hybrid outbox (Product create/update events)
//     → Neon + every terminal + the Turso replica stay in step, exactly
//     like the inventory mirror.
//   · The pushed matrix is stored (AppSetting mazajCatalog) for the
//     Integrations admin panel.
//
//   GET (admin/settings session): the last snapshot + the current managed
//   products — used by the Integrations view.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import {
  DELIVERY_WEBHOOK_KEY_SETTING,
  MAZAJ_CATALOG_KEY,
  MAZAJ_SKU_PREFIX,
} from '@/lib/constants'
import { shishaCategoryIds, shishaScopeProducts } from '@/lib/integrations/mazaj-scope'
import { emitOutboxEvent } from '@/lib/hybrid-sync/outbox'
import { withWriteLock } from '@/lib/write-mutex'

function keysMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

type CatalogItem = {
  sku?: string
  name?: string
  nameAr?: string | null
  price?: number
  active?: boolean
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
    if (!Array.isArray(body?.products) || body.products.length === 0) {
      throw new ApiError('products must be a non-empty array', 400)
    }
    if (body.products.length > 200) {
      throw new ApiError('too many products (max 200)', 400)
    }
    const items = body.products as CatalogItem[]

    // ── validate the incoming matrix ──
    const seenSkus = new Set<string>()
    const parsed: { sku: string; name: string; nameAr: string | null; price: number; active: boolean }[] = []
    for (const raw of items) {
      const sku = String(raw?.sku ?? '').trim().toUpperCase()
      if (!sku.startsWith(MAZAJ_SKU_PREFIX) || sku.length > 40 || !/^[A-Z0-9-]+$/.test(sku)) {
        throw new ApiError(
          `sku must start with "${MAZAJ_SKU_PREFIX}" and use A-Z/0-9/- only (got "${sku.slice(0, 40)}")`,
          400,
        )
      }
      if (seenSkus.has(sku)) {
        throw new ApiError(`duplicate sku in push: ${sku}`, 400)
      }
      seenSkus.add(sku)
      const name = String(raw?.name ?? '').trim()
      if (!name || name.length > 80) {
        throw new ApiError(`product name for ${sku} is required (1-80 characters)`, 400)
      }
      const nameAr = raw?.nameAr ? String(raw.nameAr).trim().slice(0, 80) : null
      const price = Number(raw?.price)
      if (!Number.isFinite(price) || price < 0 || price > 100_000) {
        throw new ApiError(`price for ${sku} must be between 0 and 100000`, 400)
      }
      parsed.push({
        sku,
        name,
        nameAr,
        price: Math.round(price * 100) / 100,
        active: raw?.active === undefined ? true : Boolean(raw.active),
      })
    }

    // ── scope + existing managed products ──
    const categoryIds = await shishaCategoryIds()
    if (categoryIds.length === 0) {
      throw new ApiError(
        'No shisha category found — create/rename a category (e.g. "Shisha") or set mazajCategoryNames in Integrations',
        409,
      )
    }
    const scope = await shishaScopeProducts()
    const bySku = new Map(
      scope.filter((p) => p.sku).map((p) => [p.sku!.trim().toUpperCase(), p]),
    )
    const managed = scope.filter((p) => (p.sku ?? '').trim().toUpperCase().startsWith(MAZAJ_SKU_PREFIX))
    const targetCategoryId = categoryIds[0]

    const created: string[] = []
    const updated: string[] = []
    const unchanged: string[] = []
    const deactivated: string[] = []
    const errors: string[] = []

    await withWriteLock(() =>
      db.$transaction(async (tx) => {
        // 1) upsert everything the platform still sells
        for (const p of parsed) {
          const existing = bySku.get(p.sku)
          if (!existing) {
            const row = await tx.product.create({
              data: {
                name: p.name,
                nameAr: p.nameAr,
                sku: p.sku,
                price: p.price,
                categoryId: targetCategoryId,
                isSellable: true,
                active: p.active,
              },
            })
            created.push(p.sku)
            await emitOutboxEvent(tx, {
              entity: 'Product',
              entityId: row.id,
              operation: 'create',
              row,
            })
            continue
          }
          const priceChanged = Math.abs(existing.price - p.price) > 0.009
          const nameChanged = existing.name !== p.name || (existing.nameAr ?? null) !== p.nameAr
          const activeChanged = existing.active !== p.active
          if (!priceChanged && !nameChanged && !activeChanged) {
            unchanged.push(p.sku)
            continue
          }
          const row = await tx.product.update({
            where: { id: existing.id },
            data: {
              name: p.name,
              nameAr: p.nameAr,
              price: p.price,
              active: p.active,
            },
          })
          updated.push(p.sku)
          await emitOutboxEvent(tx, {
            entity: 'Product',
            entityId: row.id,
            operation: 'update',
            row,
          })
        }

        // 2) managed products absent from the push → deactivated (never deleted)
        for (const m of managed) {
          const sku = m.sku!.trim().toUpperCase()
          if (seenSkus.has(sku)) continue
          if (!m.active) continue
          const row = await tx.product.update({
            where: { id: m.id },
            data: { active: false },
          })
          deactivated.push(sku)
          await emitOutboxEvent(tx, {
            entity: 'Product',
            entityId: row.id,
            operation: 'update',
            row,
          })
        }

        // 3) snapshot for the admin panel
        const snapshot = JSON.stringify({
          at: new Date().toISOString(),
          products: parsed,
        })
        await tx.appSetting.upsert({
          where: { key: MAZAJ_CATALOG_KEY },
          update: { value: snapshot },
          create: { key: MAZAJ_CATALOG_KEY, value: snapshot },
        })
      }),
    )

    await logAudit({
      user: null,
      action: 'integration.mazajCatalog',
      entity: 'system',
      details: `mazaj catalog push — ${parsed.length} type(s): ${created.length} created${created.length ? ` (${created.slice(0, 4).join(', ')}${created.length > 4 ? '…' : ''})` : ''}, ${updated.length} updated, ${unchanged.length} unchanged, ${deactivated.length} deactivated${deactivated.length ? ` (${deactivated.slice(0, 4).join(', ')}${deactivated.length > 4 ? '…' : ''})` : ''}`,
    })

    return NextResponse.json({
      ok: true,
      pushed: parsed.length,
      created: created.length,
      updated: updated.length,
      unchanged: unchanged.length,
      deactivated: deactivated.length,
      scopeCategories: categoryIds.length,
      scopeProducts: scope.length,
      errors,
    })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['admin', 'settings'])
    const [snapshotRaw, scope] = await Promise.all([
      db.appSetting.findUnique({ where: { key: MAZAJ_CATALOG_KEY } }),
      shishaScopeProducts(),
    ])
    const managed = scope.filter((p) => (p.sku ?? '').trim().toUpperCase().startsWith(MAZAJ_SKU_PREFIX))
    return NextResponse.json({
      snapshot: snapshotRaw ? JSON.parse(snapshotRaw.value) : null,
      managedProducts: managed.map((p) => ({
        id: p.id,
        sku: p.sku,
        name: p.name,
        nameAr: p.nameAr,
        price: p.price,
        active: p.active,
      })),
      scopeProducts: scope.length,
    })
  } catch (err) {
    return errorResponse(err)
  }
}
