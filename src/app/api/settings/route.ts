import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { RESTAURANT_NAME } from '@/lib/constants'

// Single editable app setting (upserted by key). Falls back to the constant
// when the row is missing so the API always resolves a restaurant name.
const RESTAURANT_NAME_KEY = 'restaurantName'

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
    const row = await db.appSetting.findUnique({
      where: { key: RESTAURANT_NAME_KEY },
    })
    return NextResponse.json({
      settings: { restaurantName: row?.value ?? RESTAURANT_NAME },
    })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function PUT(req: NextRequest) {
  try {
    await requireAuth(req, ['admin', 'settings'])
    const body = await readBody(req)

    if (typeof body.restaurantName !== 'string') {
      throw new ApiError('restaurantName is required', 400)
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

    return NextResponse.json({ settings: { restaurantName } })
  } catch (err) {
    return errorResponse(err)
  }
}
