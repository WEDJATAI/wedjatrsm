// /api/hybrid/device/self — self-enrollment for downloaded desktop agents.
//
// The Windows agent .exe (downloaded from the Launcher home behind the
// download password) has NO login session — it authenticates with an
// enrollment key that is stamped into the .exe at download time (the same
// password that gated the download). On success the agent receives its own
// hybrid device credentials (deviceId + raw deviceKey, shown exactly once —
// only sha256(key) is stored, mirroring the admin-issued POST /api/hybrid/device).
//
// Enrollment is rate-limited per IP; every self-enrolled device shows up in
// the admin device registry (Settings → Sync Center) where it can be paused,
// revoked or key-rotated like any admin-issued device.
import { NextRequest, NextResponse } from 'next/server'
import { randomUUID, randomBytes } from 'node:crypto'

import { errorResponse, ApiError } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { db } from '@/lib/db'
import { hashDeviceKey } from '@/lib/hybrid-auth'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'

/** The enrollment key = the Windows download password (same secret, one gate). */
const ENROLL_KEY = process.env.WINDOWS_DOWNLOAD_PASSWORD ?? '180787'

const PLATFORMS = new Set(['windows-agent', 'linux-agent', 'mac-agent', 'windows', 'linux', 'mac'])

export async function POST(req: NextRequest) {
  try {
    // brute-force guard: 6 enroll attempts / 10 min per IP
    const rlKey = `hybrid:self:${clientIp(req)}`
    const rl = checkRateLimit(rlKey, 6, 10 * 60_000)
    if (!rl.ok) {
      throw new ApiError(`Too many enrollment attempts — try again in ${rl.retryAfterSec}s`, 429)
    }

    const body = (await req.json().catch(() => ({}))) as {
      name?: unknown
      platform?: unknown
      enrollKey?: unknown
    }
    const enrollKey = String(body.enrollKey ?? '')
    if (enrollKey !== ENROLL_KEY) {
      await new Promise((resolve) => setTimeout(resolve, 600))
      throw new ApiError('Invalid enrollment key', 401)
    }

    const platform =
      typeof body.platform === 'string' && PLATFORMS.has(body.platform.trim())
        ? body.platform.trim()
        : 'windows-agent'
    const name =
      typeof body.name === 'string' && body.name.trim()
        ? body.name.trim().slice(0, 80)
        : `Desktop agent ${randomUUID().slice(0, 8)}`

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
      user: null,
      action: 'hybrid.deviceSelfEnroll',
      entity: 'system',
      details: `self-enrolled hybrid device "${name}" (${platform}, ${deviceId.slice(0, 8)}…) from ${clientIp(req)}`,
    })

    return NextResponse.json(
      { deviceId, deviceKey, name, platform, status: 'active' },
      { headers: { Warning: 'device key shown once' } },
    )
  } catch (err) {
    return errorResponse(err)
  }
}
