// /api/integrations/mazaj/status — R46 read-only integration feed for the
// mazaj platform. ONE key-authenticated GET answers every question the
// hookah platform asks Wedjat RSM:
//
//   GET (x-rsm-key: the SAME delivery webhook key)
//     ?ids=2188,2190   optional — order ids mazaj tracks (see below)
//
//   → {
//       ok, now,
//       tables: [ { id, name, status, floor } ],       // ACTIVE floors only
//       menu:   [ { id, sku, name, nameAr, price, active } ],  // shisha scope
//       orders: [ { id, externalRef, status, tableId, table, totalAmount,
//                   createdAt, updatedAt, closedAt } ]
//     }
//
//   · tables — the live restaurant table list for mazaj's employee order
//     screen (table NAMES repeat across floors, so the numeric id is the
//     only unambiguous reference; mazaj echoes it back as webhook tableId).
//   · menu — the current shisha catalog mirror (what the R45/R46 sync has
//     materialized) so mazaj's sync panel can display the check-side view.
//   · orders — the status of the RSM checks mazaj cares about. Pass the
//     ids mazaj knows (the wedjatOrderId returned by the order webhook —
//     add-to-check deliveries have NO externalRef on the order row, so
//     ids are the reliable key). status "cancelled" ⇒ the cafe revoked the
//     check: mazaj marks its order revoked (revocation polling).
//     Without ?ids the feed returns the 50 most recent mazaj-linked NEW
//     checks (externalRef mazaj:*) as a convenience for dashboards.
//
// Read-only, key-authenticated, zero side effects — safe to poll.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse } from '@/lib/auth'
import { DELIVERY_WEBHOOK_KEY_SETTING } from '@/lib/constants'
import { shishaScopeProducts } from '@/lib/integrations/mazaj-scope'

function keysMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
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

    // ── tables on active floors ──
    const tables = (
      await db.restaurantTable.findMany({
        where: { active: true, OR: [{ floorPlan: { active: true } }, { floorPlanId: null }] },
        include: { floorPlan: { select: { name: true } } },
        orderBy: [{ floorPlanId: 'asc' }, { id: 'asc' }],
      })
    ).map((t) => ({
      id: t.id,
      name: t.name,
      status: t.status,
      floor: t.floorPlan?.name ?? null,
    }))

    // ── shisha menu scope ──
    const menu = (await shishaScopeProducts()).map((p) => ({
      id: p.id,
      sku: p.sku,
      name: p.name,
      nameAr: p.nameAr,
      price: p.price,
      active: p.active,
    }))

    // ── order status feed ──
    const idsParam = new URL(req.url).searchParams.get('ids') ?? ''
    const ids = idsParam
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0 && n < 1_000_000_000)
      .slice(0, 100)
    const rows = ids.length
      ? await db.order.findMany({
          where: { id: { in: ids } },
          orderBy: { id: 'desc' },
        })
      : await db.order.findMany({
          where: { externalRef: { startsWith: 'mazaj:' } },
          orderBy: { id: 'desc' },
          take: 50,
        })
    const orders = rows.map((o) => ({
      id: o.id,
      externalRef: o.externalRef,
      status: o.status,
      tableId: o.tableId,
      totalAmount: o.totalAmount,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
      closedAt: o.closedAt,
    }))

    return NextResponse.json({
      ok: true,
      now: new Date().toISOString(),
      tables,
      menu,
      orders,
    })
  } catch (err) {
    return errorResponse(err)
  }
}
