// /api/sync/settings — R15 Sync Center configuration (admin/settings).
// PUT: { targetUrl?: string, autoExport?: boolean, rotateKey?: boolean, setKey?: string }
// targetUrl must be '' (unset) or an http(s) URL. Rotating the key replaces
// the stored sync key (the old one stops working immediately). R21: setKey
// installs an explicit key (paste the master's key on a Windows instance —
// closes the README-WINDOWS flow that previously had no UI). Returns the
// recomputed { sync } status shape.

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

import { requireAuth, errorResponse, ApiError } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { getSyncStatus, writeSyncSettings } from '@/lib/sync'

const SettingsBody = z.object({
  targetUrl: z
    .string()
    .max(300, 'targetUrl is too long (max 300 characters)')
    .refine(
      (v) => v === '' || /^https?:\/\/\S+$/i.test(v.trim()),
      'targetUrl must be an http(s) URL or an empty string',
    )
    .optional(),
  autoExport: z.boolean().optional(),
  rotateKey: z.boolean().optional(),
  // R21: install an explicit key (e.g. the master's key pasted on a Windows
  // instance). 8-128 chars — hex keys are 48; the range also tolerates
  // manually-chosen shared secrets.
  setKey: z
    .string()
    .trim()
    .min(8, 'setKey must be at least 8 characters')
    .max(128, 'setKey is too long (max 128 characters)')
    .optional(),
})

export async function PUT(req: NextRequest) {
  try {
    const user = await requireAuth(req, ['admin', 'settings'])

    let raw: unknown = {}
    try {
      raw = await req.json()
    } catch {
      raw = {} // invalid/empty JSON is treated as an empty body
    }
    const parsed = SettingsBody.safeParse(raw)
    if (!parsed.success) {
      throw new ApiError(parsed.error.issues[0]?.message ?? 'Invalid request body', 400)
    }

    const changed: string[] = []
    if (parsed.data.targetUrl !== undefined) {
      await writeSyncSettings({ targetUrl: parsed.data.targetUrl.trim() })
      changed.push(`targetUrl=${parsed.data.targetUrl.trim() || '(unset)'}`)
    }
    if (parsed.data.autoExport !== undefined) {
      await writeSyncSettings({ autoExport: parsed.data.autoExport })
      changed.push(`autoExport=${parsed.data.autoExport}`)
    }
    if (parsed.data.rotateKey === true) {
      await writeSyncSettings({ rotateKey: true })
      changed.push('sync key rotated')
    }
    if (parsed.data.setKey !== undefined) {
      // never echo the key itself into the audit trail
      await writeSyncSettings({ setKey: parsed.data.setKey })
      changed.push('sync key set manually')
    }
    if (changed.length === 0) throw new ApiError('Nothing to update', 400)

    await logAudit({
      user,
      action: 'sync.settings',
      entity: 'system',
      entityId: null,
      details: `Sync settings updated: ${changed.join(', ')}`,
    })

    return NextResponse.json({ sync: await getSyncStatus() })
  } catch (err) {
    return errorResponse(err)
  }
}
