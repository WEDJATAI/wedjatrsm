// /api/download/windows — password-gated download of the Windows 10 agent .exe.
//
// POST { password } → streams RSM-Windows-Agent-Setup.exe (built with
// `bun build --compile` — the Bun runtime is embedded, zero dependencies on
// the target PC). Requires a signed-in staff session AND the download
// password (WINDOWS_DOWNLOAD_PASSWORD in .env).
//
// Per-download configuration: a small `RSMCFG1:<base64>` JSON blob is
// appended AFTER the executable bytes (a PE overlay — the OS loader and the
// Bun runtime both ignore trailing data; verified by test). The agent reads
// its own tail on first run to learn its sync server, the durable cloud URL
// and its enrollment key — so a freshly downloaded agent is ready to work
// immediately, no manual configuration.
import { NextRequest, NextResponse } from 'next/server'
import { createReadStream, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'

const EXE_PATH = path.join(process.cwd(), 'agent-desktop', 'dist', 'RSM-Windows-Agent-Setup.exe')
const EXE_NAME = 'RSM-Windows-Agent-Setup.exe'
const DOWNLOAD_PASSWORD = process.env.WINDOWS_DOWNLOAD_PASSWORD ?? '180787'
const DURABLE_CLOUD_URL = process.env.VERCEL_PROD_URL ?? 'https://wedjatrsm-tonsy.vercel.app'

function requestOrigin(req: NextRequest): string {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? new URL(req.url).host
  const proto =
    req.headers.get('x-forwarded-proto') ??
    (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https')
  return `${proto}://${host}`
}

export async function POST(req: NextRequest) {
  try {
    // any signed-in staff member (waiter, cashier, manager…) — the password
    // is the actual gate; the session just keeps the URL off the open web.
    await requireAuth(req)

    // brute-force guard: 10 attempts / 5 min per IP
    const rlKey = `dl:win:${clientIp(req)}`
    const rl = checkRateLimit(rlKey, 10, 5 * 60_000)
    if (!rl.ok) {
      throw new ApiError(`Too many attempts — try again in ${rl.retryAfterSec}s`, 429)
    }

    const body = (await req.json().catch(() => ({}))) as { password?: unknown }
    const password = String(body?.password ?? '')
    if (password !== DOWNLOAD_PASSWORD) {
      await new Promise((resolve) => setTimeout(resolve, 600))
      throw new ApiError('Incorrect download password', 403)
    }

    if (!existsSync(EXE_PATH)) {
      throw new ApiError(
        'The Windows agent package is not built on this instance — build agent-desktop first',
        404,
      )
    }
    const size = statSync(EXE_PATH).size

    // per-download tail config (PE overlay): sync server = the instance the
    // user downloaded from, durable fallback = the Vercel production hub.
    const origin = requestOrigin(req)
    const configJson = JSON.stringify({
      v: 1,
      baseUrl: origin,
      cloudUrl: DURABLE_CLOUD_URL,
      enrollKey: DOWNLOAD_PASSWORD,
      gen: new Date().toISOString(),
    })
    const tail = Buffer.from(`\nRSMCFG1:${Buffer.from(configJson).toString('base64')}`)

    const fileBody = new ReadableStream<Uint8Array>({
      async start(controller) {
        const nodeStream = createReadStream(EXE_PATH)
        for await (const chunk of nodeStream) {
          controller.enqueue(new Uint8Array(chunk as Buffer))
        }
        controller.enqueue(new Uint8Array(tail))
        controller.close()
      },
    })

    await logAudit({
      user: null,
      action: 'desktop.agentDownload',
      entity: 'system',
      details: `Windows agent .exe downloaded (${((size + tail.length) / (1024 * 1024)).toFixed(1)} MB, server ${origin})`,
    })

    return new Response(fileBody, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${EXE_NAME}"`,
        'Content-Length': String(size + tail.length),
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    return errorResponse(err)
  }
}
