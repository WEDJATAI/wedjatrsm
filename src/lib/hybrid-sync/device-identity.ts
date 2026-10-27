/**
 * R30 hybrid sync — local device identity.
 *
 * Every installation participating in hybrid sync owns exactly one LOCAL
 * device row. The identity is created lazily on first use (the engine, an
 * admin action) and persisted in HybridSyncState:
 *  - 'local.deviceId'  → the public identity (HybridDevice.deviceId)
 *  - 'local.deviceKey' → the RAW 64-hex secret, stored ONLY in the local DB
 *
 * This mirrors how the Electron shell persists its per-installation JWT
 * secret (desktop/main.js): the raw key never leaves the device; peers and
 * the cloud only ever see sha256(key) (HybridDevice.keyHash).
 */
import { randomUUID, randomBytes } from 'node:crypto'

import type { HybridDevice } from '@prisma/client'

import { db } from '@/lib/db'
import { sha256Hex } from './serialization'
import { getState, setState, STATE_LOCAL_DEVICE_ID, STATE_LOCAL_DEVICE_KEY } from './sync-state'

export type LocalDeviceIdentity = {
  deviceId: string
  installationId: string
  deviceKey: string
}

/**
 * Return the local device identity, creating it on first call.
 * Safe to call concurrently / repeatedly — the state row is the source of
 * truth and a unique-constraint race falls back to re-reading.
 */
export async function ensureLocalDevice(): Promise<LocalDeviceIdentity> {
  const storedId = await getState(STATE_LOCAL_DEVICE_ID)
  if (storedId) {
    const device = await db.hybridDevice.findUnique({ where: { deviceId: storedId } })
    const key = await getState(STATE_LOCAL_DEVICE_KEY)
    if (device && key) {
      return { deviceId: device.deviceId, installationId: device.installationId, deviceKey: key }
    }
    // orphaned state (device row or key missing) — fall through and recreate
  }

  const deviceId = randomUUID()
  const installationId = randomUUID()
  const deviceKey = randomBytes(32).toString('hex') // 64-hex

  try {
    await db.hybridDevice.create({
      data: {
        deviceId,
        installationId,
        name: 'Local Terminal',
        platform: 'windows',
        keyHash: sha256Hex(deviceKey),
        status: 'active',
      },
    })
  } catch {
    // unique-constraint race (two concurrent first calls) — adopt the winner
    const existing = await getState(STATE_LOCAL_DEVICE_ID)
    if (existing) {
      const device = await db.hybridDevice.findUnique({ where: { deviceId: existing } })
      const key = await getState(STATE_LOCAL_DEVICE_KEY)
      if (device && key) {
        return { deviceId: device.deviceId, installationId: device.installationId, deviceKey: key }
      }
    }
    throw new Error('failed to establish local hybrid device identity')
  }

  await setState(STATE_LOCAL_DEVICE_ID, deviceId)
  await setState(STATE_LOCAL_DEVICE_KEY, deviceKey)
  return { deviceId, installationId, deviceKey }
}

/** The local device row (null before the first ensureLocalDevice call). */
export async function getLocalDevice(): Promise<HybridDevice | null> {
  const storedId = await getState(STATE_LOCAL_DEVICE_ID)
  if (!storedId) return null
  return db.hybridDevice.findUnique({ where: { deviceId: storedId } })
}
