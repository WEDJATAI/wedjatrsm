import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { DELETE_PIN_KEY, DELETE_PIN_LENGTH, RESTAURANT_NAME, RESTAURANT_NAME_AR } from '@/lib/constants'

// Editable app settings (upserted by key). Falls back to the constants
// when rows are missing so the API always resolves a restaurant name.
const RESTAURANT_NAME_KEY = 'restaurantName'
const RESTAURANT_NAME_AR_KEY = 'restaurantNameAr'

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

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req)
    const rows = await db.appSetting.findMany({
      where: { key: { in: [RESTAURANT_NAME_KEY, RESTAURANT_NAME_AR_KEY] } },
    })
    const byKey = new Map(rows.map((row) => [row.key, row.value]))
    return NextResponse.json({
      settings: {
        restaurantName: byKey.get(RESTAURANT_NAME_KEY) ?? RESTAURANT_NAME,
        restaurantNameAr: byKey.get(RESTAURANT_NAME_AR_KEY) ?? RESTAURANT_NAME_AR,
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

    // keys actually persisted in this request (audit summary — VALUES are
    // never logged: the PIN and names stay write-only / non-sensitive keys)
    const changedKeys: string[] = []

    // ── Restaurant name (English) ──
    if (body.restaurantName !== undefined) {
      if (typeof body.restaurantName !== 'string') {
        throw new ApiError('restaurantName must be a string', 400)
      }
      const restaurantName = body.restaurantName.trim()
      if (restaurantName.length < 1 || restaurantName.length > 60) {
        throw new ApiError('restaurantName must be between 1 and 60 characters', 400)
      }
      await db.appSetting.upsert({
        where: { key: RESTAURANT_NAME_KEY },
        update: { value: restaurantName },
        create: { key: RESTAURANT_NAME_KEY, value: restaurantName },
      })
      changedKeys.push('restaurantName')
    }

    // ── Restaurant name (Arabic — printed on bilingual checks) ──
    if (body.restaurantNameAr !== undefined) {
      if (typeof body.restaurantNameAr !== 'string') {
        throw new ApiError('restaurantNameAr must be a string', 400)
      }
      const restaurantNameAr = body.restaurantNameAr.trim()
      if (restaurantNameAr.length > 60) {
        throw new ApiError('restaurantNameAr must be at most 60 characters', 400)
      }
      // empty string clears the Arabic name (checks fall back to the EN name)
      await db.appSetting.upsert({
        where: { key: RESTAURANT_NAME_AR_KEY },
        update: { value: restaurantNameAr },
        create: { key: RESTAURANT_NAME_AR_KEY, value: restaurantNameAr },
      })
      changedKeys.push('restaurantNameAr')
    }

    // ── Item-deletion PIN (6 digits, admin-set, usable by any staff) ──
    if (body.deleteItemPin !== undefined) {
      if (typeof body.deleteItemPin !== 'string') {
        throw new ApiError('deleteItemPin must be a string', 400)
      }
      const pin = body.deleteItemPin.trim()
      if (!new RegExp(`^\\d{${DELETE_PIN_LENGTH}}$`).test(pin)) {
        throw new ApiError(`deleteItemPin must be exactly ${DELETE_PIN_LENGTH} digits`, 400)
      }
      await db.appSetting.upsert({
        where: { key: DELETE_PIN_KEY },
        update: { value: pin },
        create: { key: DELETE_PIN_KEY, value: pin },
      })
      changedKeys.push('deleteItemPin')
    }

    if (changedKeys.length > 0) {
      await logAudit({
        user,
        action: 'settings.update',
        entity: 'settings',
        entityId: null,
        details: `Updated keys: ${changedKeys.join(', ')}`,
      })
    }

    const rows = await db.appSetting.findMany({
      where: { key: { in: [RESTAURANT_NAME_KEY, RESTAURANT_NAME_AR_KEY] } },
    })
    const byKey = new Map(rows.map((row) => [row.key, row.value]))
    return NextResponse.json({
      settings: {
        restaurantName: byKey.get(RESTAURANT_NAME_KEY) ?? RESTAURANT_NAME,
        restaurantNameAr: byKey.get(RESTAURANT_NAME_AR_KEY) ?? RESTAURANT_NAME_AR,
      },
    })
  } catch (err) {
    return errorResponse(err)
  }
}
