// /api/deductions/rules — r65: the lateness rules that convert attendance
// lateness into salary deductions. The manager (admin/developer/super admin)
// or a 'deductions'-permission holder DETERMINES these rules (owner
// directive 6+7: the role assigned by the manager sets the lateness rules).
//
// GET — the rules in force (parsed + clamped, defaults when unset).
// PUT { enabled, perMinuteEgp, perOccurrenceEgp, capEgp } — persist them
//   (AppSetting 'latenessRules', JSON). Audited. Rules are per-plane
//   configuration (like user rates) — the deductions they produce are
//   computed live on every plane from its local rules + synced attendance.

import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireAuth, errorResponse, ApiError } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import {
  LATENESS_RULES_KEY,
  LATENESS_RULES_BOUNDS,
  parseLatenessRules,
} from '@/lib/constants'

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['admin', 'deductions'])
    const row = await db.appSetting.findUnique({ where: { key: LATENESS_RULES_KEY } })
    return NextResponse.json({ rules: parseLatenessRules(row?.value) })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function PUT(req: NextRequest) {
  try {
    const session = await requireAuth(req, ['admin', 'deductions'])

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) throw new ApiError('A JSON body is required', 400)

    const clamp = (v: unknown, b: { min: number; max: number }): number => {
      const n = Number(v)
      if (!Number.isFinite(n)) throw new ApiError('Rule values must be numbers', 400)
      return Math.min(b.max, Math.max(b.min, Math.round(n * 100) / 100))
    }
    const rules = {
      enabled: body.enabled === true,
      perMinuteEgp: clamp(body.perMinuteEgp, LATENESS_RULES_BOUNDS.perMinuteEgp),
      perOccurrenceEgp: clamp(body.perOccurrenceEgp, LATENESS_RULES_BOUNDS.perOccurrenceEgp),
      capEgp: clamp(body.capEgp, LATENESS_RULES_BOUNDS.capEgp),
    }

    const previousRow = await db.appSetting.findUnique({ where: { key: LATENESS_RULES_KEY } })
    const previous = parseLatenessRules(previousRow?.value)

    await db.appSetting.upsert({
      where: { key: LATENESS_RULES_KEY },
      create: { key: LATENESS_RULES_KEY, value: JSON.stringify(rules) },
      update: { value: JSON.stringify(rules) },
    })

    await logAudit({
      user: session,
      action: 'deduction.rulesUpdate',
      entity: 'payroll',
      entityId: 0,
      details:
        `Lateness rules: ${previous.enabled ? 'ON' : 'OFF'} ` +
        `(${previous.perMinuteEgp} EGP/min, ${previous.perOccurrenceEgp} EGP/occurrence, cap ${previous.capEgp}) → ` +
        `${rules.enabled ? 'ON' : 'OFF'} (${rules.perMinuteEgp} EGP/min, ${rules.perOccurrenceEgp} EGP/occurrence, cap ${rules.capEgp})`,
    })

    return NextResponse.json({ rules })
  } catch (err) {
    return errorResponse(err)
  }
}
