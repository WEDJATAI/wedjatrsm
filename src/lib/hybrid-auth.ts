/**
 * R30 hybrid sync — device authentication.
 *
 * The 5th machine-auth precedent of the platform (after the rsm-sync key,
 * the vision ingest key, the delivery webhook key and CRON_SECRET): a device
 * presents `x-hybrid-device` (its public id) + `x-hybrid-key` (its raw
 * secret). Only sha256(key) is stored (HybridDevice.keyHash) and the compare
 * is constant-time via timingSafeEqual — mirroring
 * src/app/api/sync/import/route.ts.
 *
 * requireSessionOrDevice() gives routes the dual-auth door: a logged-in
 * admin session OR a registered, active device.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import type { NextRequest } from 'next/server'
import type { HybridDevice } from '@prisma/client'

import { db } from '@/lib/db'
import { requireAuth, type SessionPayload } from '@/lib/auth'

/** sha256 hex of the raw device key (what HybridDevice.keyHash stores). */
export function hashDeviceKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex')
}

/** Constant-time key comparison (length mismatch fails fast — the key length
 * is public knowledge anyway: 64 hex). */
function keysMatch(provided: string, storedHash: string): boolean {
  const a = Buffer.from(hashDeviceKey(provided), 'utf8')
  const b = Buffer.from(storedHash, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Authenticate a request as a device. Returns the device row on success
 * (fire-and-forget refreshes lastSeenAt), null on ANY failure — unknown
 * device, revoked/paused device, wrong key.
 */
export async function requireDevice(req: NextRequest): Promise<HybridDevice | null> {
  const deviceId = (req.headers.get('x-hybrid-device') ?? '').trim()
  const deviceKey = (req.headers.get('x-hybrid-key') ?? '').trim()
  if (!deviceId || !deviceKey) return null

  const device = await db.hybridDevice.findUnique({ where: { deviceId } })
  if (!device) return null
  if (device.status !== 'active') return null // paused | revoked
  if (!keysMatch(deviceKey, device.keyHash)) return null

  // fire-and-forget presence signal (routes stamp lastPushAt/lastPullAt)
  void db.hybridDevice
    .update({ where: { id: device.id }, data: { lastSeenAt: new Date() } })
    .catch(() => {})
  return device
}

export type SessionOrDevice =
  | { type: 'session'; user: SessionPayload }
  | { type: 'device'; device: HybridDevice }

/**
 * Dual auth: an admin session (with the optional permission gate) first,
 * then device headers. Null when neither path succeeds.
 */
export async function requireSessionOrDevice(
  req: NextRequest,
  perms?: string[],
): Promise<SessionOrDevice | null> {
  try {
    const user = await requireAuth(req, perms)
    return { type: 'session', user }
  } catch {
    const device = await requireDevice(req)
    if (device) return { type: 'device', device }
    return null
  }
}
