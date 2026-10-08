import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, ensureDeveloper, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'

/**
 * p11-d — change the DEVELOPER's PIN (the developer role's own number).
 *
 * Only the developer himself can call this: he proves ownership of the
 * current PIN and picks a new 6-digit one (confirmed twice client-side,
 * re-validated here). Mirrors the R27 manager PIN contract — reachable
 * from the first-time prompt and the launcher's "My PIN" button.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth(req)

    // ── only the developer touches the developer's PIN ────────────────
    // (ensureDeveloper keeps the one-developer invariant alive)
    const developer = await ensureDeveloper()
    if (session.userId !== developer.id) {
      throw new ApiError('Only the developer can change the developer PIN', 403)
    }

    let body: Record<string, unknown> = {}
    try {
      const parsed: unknown = await req.json()
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>
      }
    } catch {
      // fall through → 400 below
    }
    const str = (v: unknown) => (v == null ? '' : String(v).trim())
    const currentPin = str(body.currentPin)
    const newPin = str(body.newPin)
    const confirmPin = str(body.confirmPin)

    if (!/^\d{6}$/.test(newPin)) {
      throw new ApiError('New PIN must be exactly 6 digits', 400)
    }
    if (newPin !== confirmPin) {
      throw new ApiError('The two new PINs do not match', 400)
    }
    if (newPin === currentPin) {
      throw new ApiError('New PIN must be different from the current one', 400)
    }

    // brute-force guard on the current-PIN proof (10 tries / 5 min / IP)
    const rlKey = `developer-pin:${clientIp(req)}`
    const rl = checkRateLimit(rlKey, 10, 5 * 60 * 1000)
    if (!rl.ok) {
      throw new ApiError(`Too many attempts — try again in ${rl.retryAfterSec}s`, 429)
    }

    if (developer.pin !== currentPin) {
      throw new ApiError('Current PIN is incorrect', 401)
    }

    await db.user.update({
      where: { id: developer.id },
      data: { pin: newPin },
    })

    await logAudit({
      user: session,
      action: 'developer.pinChange',
      entity: 'user',
      entityId: developer.id,
      details: `Developer ${developer.name} (${developer.email}) changed the developer sign-in PIN`,
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return errorResponse(err)
  }
}
