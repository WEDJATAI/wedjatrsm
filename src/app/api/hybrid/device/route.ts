// /api/hybrid/device — R30 device registry management (admin only).
//
//  GET    list devices (public identity is fine to show; the keyHash is
//         NEVER returned)
//  POST   register a device → the raw 64-hex deviceKey is generated server-
//         side and shown EXACTLY ONCE in the response (sha256 is stored)
//  PATCH  { deviceId, action: pause|resume|revoke|rotate|rename, name? }
//         — rotate issues a fresh key (shown once); revoked devices fail
//         requireDevice immediately
import { NextRequest, NextResponse } from 'next/server'
import { randomUUID, randomBytes } from 'node:crypto'

import { errorResponse, ApiError, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { db } from '@/lib/db'
import { hashDeviceKey } from '@/lib/hybrid-auth'

const DEVICE_ACTIONS = ['pause', 'resume', 'revoke', 'rotate', 'rename'] as const
type DeviceAction = (typeof DEVICE_ACTIONS)[number]

function serializeDevice(device: {
  id: number
  deviceId: string
  installationId: string
  name: string
  platform: string
  status: string
  lastSeenAt: Date | null
  lastPushAt: Date | null
  lastPullAt: Date | null
  createdAt: Date
}) {
  return {
    id: device.id,
    deviceId: device.deviceId,
    installationId: device.installationId,
    name: device.name,
    platform: device.platform,
    status: device.status,
    lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
    lastPushAt: device.lastPushAt?.toISOString() ?? null,
    lastPullAt: device.lastPullAt?.toISOString() ?? null,
    createdAt: device.createdAt.toISOString(),
  }
}

export async function GET(req: NextRequest) {
  try {
    await requireAuth(req, ['settings'])
    const devices = await db.hybridDevice.findMany({ orderBy: { createdAt: 'asc' } })
    return NextResponse.json({ devices: devices.map(serializeDevice) })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function POST(req: NextRequest) {
  try {
    const session = await requireAuth(req, ['settings'])
    const body: { name?: unknown; platform?: unknown } = await req.json().catch(() => ({}))
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const platform = typeof body.platform === 'string' && body.platform.trim() ? body.platform.trim() : 'windows'
    if (!name) throw new ApiError('name is required', 400)
    if (name.length > 80) throw new ApiError('name too long (max 80)', 400)

    const deviceId = randomUUID()
    const installationId = randomUUID()
    const deviceKey = randomBytes(32).toString('hex') // 64-hex, shown once

    await db.hybridDevice.create({
      data: {
        deviceId,
        installationId,
        name,
        platform,
        keyHash: hashDeviceKey(deviceKey),
        status: 'active',
      },
    })
    await logAudit({
      user: session,
      action: 'hybrid.deviceCreate',
      entity: 'system',
      details: `registered hybrid device "${name}" (${platform}, ${deviceId.slice(0, 8)}…)`,
    })

    return NextResponse.json(
      { deviceId, deviceKey, name, platform, status: 'active' },
      { headers: { Warning: 'device key shown once' } },
    )
  } catch (err) {
    return errorResponse(err)
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const session = await requireAuth(req, ['settings'])
    const body: { deviceId?: unknown; action?: unknown; name?: unknown } = await req.json().catch(() => ({}))
    const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : ''
    const action = typeof body.action === 'string' ? (body.action as DeviceAction) : null
    if (!deviceId) throw new ApiError('deviceId is required', 400)
    if (!action || !DEVICE_ACTIONS.includes(action)) {
      throw new ApiError(`action must be one of ${DEVICE_ACTIONS.join(', ')}`, 400)
    }

    const device = await db.hybridDevice.findUnique({ where: { deviceId } })
    if (!device) throw new ApiError('Device not found', 404)

    let rotatedKey: string | null = null
    switch (action) {
      case 'pause':
        await db.hybridDevice.update({ where: { id: device.id }, data: { status: 'paused' } })
        break
      case 'resume':
        await db.hybridDevice.update({ where: { id: device.id }, data: { status: 'active' } })
        break
      case 'revoke':
        await db.hybridDevice.update({ where: { id: device.id }, data: { status: 'revoked' } })
        break
      case 'rotate': {
        rotatedKey = randomBytes(32).toString('hex')
        await db.hybridDevice.update({
          where: { id: device.id },
          data: { keyHash: hashDeviceKey(rotatedKey), status: 'active' },
        })
        break
      }
      case 'rename': {
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        if (!name) throw new ApiError('name is required for rename', 400)
        if (name.length > 80) throw new ApiError('name too long (max 80)', 400)
        await db.hybridDevice.update({ where: { id: device.id }, data: { name } })
        break
      }
    }

    await logAudit({
      user: session,
      action: 'hybrid.deviceUpdate',
      entity: 'system',
      details: `hybrid device "${device.name}" (${deviceId.slice(0, 8)}…): ${action}`,
    })

    const updated = await db.hybridDevice.findUnique({ where: { id: device.id } })
    if (!updated) throw new ApiError('Device not found', 404)
    return NextResponse.json(
      {
        device: serializeDevice(updated),
        ...(rotatedKey !== null ? { deviceKey: rotatedKey } : {}),
      },
      rotatedKey !== null ? { headers: { Warning: 'device key shown once' } } : undefined,
    )
  } catch (err) {
    return errorResponse(err)
  }
}
