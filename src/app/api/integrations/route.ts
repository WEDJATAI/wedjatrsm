// /api/integrations — R13 integration hub settings (admin/settings).
// GET  : loyalty config, delivery webhook (key + last deliveries), ETA fields.
// PUT  : update loyalty/ETA config, regenerate the delivery webhook key.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import {
  DELIVERY_WEBHOOK_KEY_SETTING,
  ETA_ADDRESS_KEY,
  ETA_REG_NUMBER_KEY,
  LOYALTY_BOUNDS,
  LOYALTY_DEFAULTS,
  LOYALTY_EGP_PER_POINT_KEY,
  LOYALTY_ENABLED_KEY,
  LOYALTY_POINTS_PER_EGP_KEY,
} from '@/lib/constants'
import { getLoyaltySettings } from '@/lib/loyalty'

async function readBody(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await req.json()
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // fall through — invalid/empty JSON is treated as an empty body
  }
  return {}
}

/** crypto-random webhook key (hex, 32 chars). */
function newWebhookKey(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** R16: mask a key for list responses — full value only at (re)generation time. */
function maskKey(key: string | null): string | null {
  if (!key) return null
  if (key.length <= 8) return '••••'
  return `${key.slice(0, 4)}••••${key.slice(-4)}`
}

async function readSetting(key: string): Promise<string | null> {
  const row = await db.appSetting.findUnique({ where: { key } })
  return row?.value ?? null
}

async function upsertSetting(key: string, value: string): Promise<void> {
  await db.appSetting.upsert({ where: { key }, update: { value }, create: { key, value } })
}

export async function GET(req: NextRequest) {
  try {
    const sessionUser = await requireAuth(req, ['admin', 'settings', 'customers'])

    const [loyalty, webhookKeyRaw, etaReg, etaAddress] = await Promise.all([
      getLoyaltySettings(),
      readSetting(DELIVERY_WEBHOOK_KEY_SETTING),
      readSetting(ETA_REG_NUMBER_KEY),
      readSetting(ETA_ADDRESS_KEY),
    ])

    // stats for the admin panel: recent external (webhook) orders
    const recentExternal = await db.order.findMany({
      where: { externalRef: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        externalRef: true,
        clientName: true,
        deliveryPhone: true,
        totalAmount: true,
        status: true,
        createdAt: true,
      },
    })

    return NextResponse.json({
      loyalty,
      deliveryWebhook: {
        // R16: full key only for admins (they configure aggregators);
        // semi-privileged roles (settings/customers permissions) get the
        // masked form. Regeneration (PUT) reveals the fresh value once.
        key: sessionUser.role === 'admin' ? webhookKeyRaw : maskKey(webhookKeyRaw),
        keyGenerated: webhookKeyRaw != null,
        recentOrders: recentExternal.map((o) => ({
          ...o,
          totalAmount: Math.round(o.totalAmount * 100) / 100,
          createdAt: o.createdAt.toISOString(),
        })),
      },
      eta: {
        registrationNumber: etaReg ?? '',
        address: etaAddress ?? '',
      },
    })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function PUT(req: NextRequest) {
  try {
    const user = await requireAuth(req, ['admin', 'settings'])
    const body = await readBody(req)
    const changed: string[] = []

    // ── loyalty config ──
    if (body?.loyalty !== undefined && body.loyalty !== null && typeof body.loyalty === 'object') {
      const loyalty = body.loyalty as Record<string, unknown>

      if (loyalty.enabled !== undefined) {
        if (typeof loyalty.enabled !== 'boolean') {
          throw new ApiError('loyalty.enabled must be true or false', 400)
        }
        await upsertSetting(LOYALTY_ENABLED_KEY, String(loyalty.enabled))
        changed.push(`loyalty.enabled=${loyalty.enabled}`)
      }

      if (loyalty.pointsPerEgp !== undefined) {
        const n = Number(loyalty.pointsPerEgp)
        if (
          !Number.isFinite(n) ||
          n < LOYALTY_BOUNDS.pointsPerEgp.min ||
          n > LOYALTY_BOUNDS.pointsPerEgp.max
        ) {
          throw new ApiError(
            `loyalty.pointsPerEgp must be between ${LOYALTY_BOUNDS.pointsPerEgp.min} and ${LOYALTY_BOUNDS.pointsPerEgp.max}`,
            400,
          )
        }
        await upsertSetting(LOYALTY_POINTS_PER_EGP_KEY, String(n))
        changed.push(`loyalty.pointsPerEgp=${n}`)
      }

      if (loyalty.egpPerPoint !== undefined) {
        const n = Number(loyalty.egpPerPoint)
        if (
          !Number.isFinite(n) ||
          n < LOYALTY_BOUNDS.egpPerPoint.min ||
          n > LOYALTY_BOUNDS.egpPerPoint.max
        ) {
          throw new ApiError(
            `loyalty.egpPerPoint must be between ${LOYALTY_BOUNDS.egpPerPoint.min} and ${LOYALTY_BOUNDS.egpPerPoint.max}`,
            400,
          )
        }
        await upsertSetting(LOYALTY_EGP_PER_POINT_KEY, String(n))
        changed.push(`loyalty.egpPerPoint=${n}`)
      }
    }

    // ── ETA taxpayer fields ──
    if (body?.eta !== undefined && body.eta !== null && typeof body.eta === 'object') {
      const eta = body.eta as Record<string, unknown>
      if (eta.registrationNumber !== undefined) {
        const raw = String(eta.registrationNumber).trim()
        if (raw.length > 30) throw new ApiError('ETA registration number is too long (max 30)', 400)
        await upsertSetting(ETA_REG_NUMBER_KEY, raw)
        changed.push('eta.registrationNumber')
      }
      if (eta.address !== undefined) {
        const raw = String(eta.address).trim()
        if (raw.length > 200) throw new ApiError('ETA address is too long (max 200)', 400)
        await upsertSetting(ETA_ADDRESS_KEY, raw)
        changed.push('eta.address')
      }
    }

    // ── webhook key (re)generation ──
    let freshWebhookKey: string | null = null
    if (body?.regenerateWebhookKey === true) {
      const key = newWebhookKey()
      await upsertSetting(DELIVERY_WEBHOOK_KEY_SETTING, key)
      freshWebhookKey = key // shown exactly once, in this response
      changed.push('deliveryWebhookKey regenerated')
    }

    if (changed.length === 0) throw new ApiError('Nothing to update', 400)

    await logAudit({
      user,
      action: 'integration.update',
      entity: 'integration',
      entityId: null,
      details: `Updated: ${changed.join(', ')}`,
    })

    // return the fresh state (same shape as GET). The webhook key is masked
    // UNLESS it was just regenerated — the one moment the full value is shown.
    const [loyalty, webhookKeyRaw, etaReg, etaAddress] = await Promise.all([
      getLoyaltySettings(),
      readSetting(DELIVERY_WEBHOOK_KEY_SETTING),
      readSetting(ETA_REG_NUMBER_KEY),
      readSetting(ETA_ADDRESS_KEY),
    ])
    return NextResponse.json({
      loyalty,
      deliveryWebhook: {
        key: freshWebhookKey ?? maskKey(webhookKeyRaw),
        keyGenerated: webhookKeyRaw != null,
        recentOrders: [],
      },
      eta: { registrationNumber: etaReg ?? '', address: etaAddress ?? '' },
    })
  } catch (err) {
    return errorResponse(err)
  }
}
