import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'

/**
 * R27 — change the MANAGER's PIN (the super admin's own number).
 *
 * Only the super admin himself can call this: he proves ownership of the
 * current PIN and picks a new 6-digit one (confirmed twice client-side,
 * re-validated here). This is the "then he can change the pin" part of
 * the manager sign-in contract — reachable from the first-time prompt
 * and the launcher's "Change my PIN" button.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth(req)

    // ── only the manager touches the manager's PIN ────────────────────
    const manager = await db.user.findFirst({ where: { isSuperAdmin: true } })
    if (!manager) throw new ApiError('Manager account not found', 404)
    if (session.userId !== manager.id) {
      throw new ApiError('Only the manager can change the manager PIN', 403)
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
    const rlKey = `manager-pin:${clientIp(req)}`
    const rl = checkRateLimit(rlKey, 10, 5 * 60 * 1000)
    if (!rl.ok) {
      throw new ApiError(`Too many attempts — try again in ${rl.retryAfterSec}s`, 429)
    }

    if (manager.pin !== currentPin) {
      throw new ApiError('Current PIN is incorrect', 401)
    }

    await db.user.update({
      where: { id: manager.id },
      data: { pin: newPin },
    })

    await logAudit({
      user: session,
      action: 'manager.pinChange',
      entity: 'user',
      entityId: manager.id,
      details: `Manager ${manager.name} (${manager.email}) changed the manager sign-in PIN`,
    })

    return NextResponse.json({ ok: true })
  } catch (err) {
    return errorResponse(err)
  }
}
