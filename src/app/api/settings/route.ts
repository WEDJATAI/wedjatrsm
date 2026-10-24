import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { DELETE_PIN_KEY, DELETE_PIN_LENGTH, RESTAURANT_LOCATION, RESTAURANT_LOCATION_AR, RESTAURANT_NAME, RESTAURANT_NAME_AR } from '@/lib/constants'

// Editable app settings (upserted by key). Falls back to the constants
// when rows are missing so the API always resolves a restaurant name.
const RESTAURANT_NAME_KEY = 'restaurantName'
const RESTAURANT_NAME_AR_KEY = 'restaurantNameAr'
// r53: the cafe's location (identity surfaces + printed papers).
const RESTAURANT_LOCATION_KEY = 'restaurantLocation'
const RESTAURANT_LOCATION_AR_KEY = 'restaurantLocationAr'

/** Resolve a stored setting. `blankFallback` = `||` (an empty stored value
 * falls back — used for the NEW location keys so they can never render
 * blank). Names keep the original `??` semantics (an explicitly cleared
 * Arabic name stays cleared — documented behavior). */
function withFallback(value: string | undefined, fallback: string, blankFallback = false): string {
  return blankFallback ? value?.trim() || fallback : (value ?? fallback)
}

/** Read the resolved settings snapshot (names + location). */
async function readSettings() {
  const rows = await db.appSetting.findMany({
    where: {
      key: {
        in: [RESTAURANT_NAME_KEY, RESTAURANT_NAME_AR_KEY, RESTAURANT_LOCATION_KEY, RESTAURANT_LOCATION_AR_KEY],
      },
    },
  })
  const byKey = new Map(rows.map((row) => [row.key, row.value]))
  return {
    restaurantName: withFallback(byKey.get(RESTAURANT_NAME_KEY), RESTAURANT_NAME),
    restaurantNameAr: withFallback(byKey.get(RESTAURANT_NAME_AR_KEY), RESTAURANT_NAME_AR),
    restaurantLocation: withFallback(byKey.get(RESTAURANT_LOCATION_KEY), RESTAURANT_LOCATION, true),
    restaurantLocationAr: withFallback(byKey.get(RESTAURANT_LOCATION_AR_KEY), RESTAURANT_LOCATION_AR, true),
  }
}

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
    return NextResponse.json({ settings: await readSettings() })
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

    // ── Restaurant location (r53 — identity surfaces + printed papers) ──
    if (body.restaurantLocation !== undefined) {
      if (typeof body.restaurantLocation !== 'string') {
        throw new ApiError('restaurantLocation must be a string', 400)
      }
      const restaurantLocation = body.restaurantLocation.trim()
      if (restaurantLocation.length > 120) {
        throw new ApiError('restaurantLocation must be at most 120 characters', 400)
      }
      // empty string clears the stored value (reads fall back to the default)
      await db.appSetting.upsert({
        where: { key: RESTAURANT_LOCATION_KEY },
        update: { value: restaurantLocation },
        create: { key: RESTAURANT_LOCATION_KEY, value: restaurantLocation },
      })
      changedKeys.push('restaurantLocation')
    }

    // ── Restaurant location (Arabic — printed on bilingual papers) ──
    if (body.restaurantLocationAr !== undefined) {
      if (typeof body.restaurantLocationAr !== 'string') {
        throw new ApiError('restaurantLocationAr must be a string', 400)
      }
      const restaurantLocationAr = body.restaurantLocationAr.trim()
      if (restaurantLocationAr.length > 120) {
        throw new ApiError('restaurantLocationAr must be at most 120 characters', 400)
      }
      // empty string clears the stored value (reads fall back to the default)
      await db.appSetting.upsert({
        where: { key: RESTAURANT_LOCATION_AR_KEY },
        update: { value: restaurantLocationAr },
        create: { key: RESTAURANT_LOCATION_AR_KEY, value: restaurantLocationAr },
      })
      changedKeys.push('restaurantLocationAr')
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

    return NextResponse.json({ settings: await readSettings() })
  } catch (err) {
    return errorResponse(err)
  }
}
