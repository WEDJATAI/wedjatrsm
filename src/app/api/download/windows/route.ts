// /api/download/windows — password-gated download of the Windows 10 agent .exe.
//
// TWO complementary transports (r34 — the old POST-only blob download was
// silently blocked inside sandboxed preview iframes, and the Vercel
// deployment had no .exe at all because agent-desktop/dist is gitignored):
//
//   POST { password }        → session + password gate → returns JSON
//                              { url, name, size, mirror } where `url` is a
//                              short-lived signed GET link and `mirror` is
//                              the public GitHub Release asset (always
//                              available, works from any browser).
//   GET  ?token=<exp>.<sig>  → verifies the stateless HMAC token (no
//                              server state — works across Vercel lambdas),
//                              then either:
//                                · streams the LOCAL .exe with a
//                                  per-download RSMCFG1 tail (sync server =
//                                  the origin the user downloaded from), or
//                                · 302-redirects to the GitHub mirror when
//                                  no local build exists (Vercel: the exe
//                                  is 97 MB and gitignored by design — the
//                                  mirror carries a baked cloud tail).
//
// The browser navigates to the GET link (native download, no JS blob) —
// this works in full tabs and in iframes that allow downloads, and the
// visible mirror link covers every remaining context.
import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'
import path from 'node:path'

import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'

const EXE_PATH = path.join(process.cwd(), 'agent-desktop', 'dist', 'RSM-Windows-Agent-Setup.exe')
const EXE_NAME = 'RSM-Windows-Agent-Setup.exe'
const DOWNLOAD_PASSWORD = process.env.WINDOWS_DOWNLOAD_PASSWORD ?? '180787'
const DURABLE_CLOUD_URL = process.env.VERCEL_PROD_URL ?? 'https://wedjatrsm-tonsy.vercel.app'
/** Public GitHub Release asset (baked cloud tail) — the always-on mirror. */
const MIRROR_URL =
  process.env.WINDOWS_AGENT_MIRROR ??
  'https://github.com/WEDJATAI/wedjatrsm/releases/download/windows-agent-v1/RSM-Windows-Agent-Setup.exe'

/** Signed-link lifetime (ms). */
const TOKEN_TTL_MS = 10 * 60_000
const TOKEN_PURPOSE = 'dlwin'

function hmac(payload: string): string {
  return createHmac('sha256', process.env.JWT_SECRET ?? 'rms-dev-secret').update(payload).digest('base64url')
}

/** Stateless single-purpose download token: `<exp>.<base64url hmac>`. */
function mintToken(): string {
  const exp = Date.now() + TOKEN_TTL_MS
  return `${exp}.${hmac(`${TOKEN_PURPOSE}.${exp}`)}`
}

function verifyToken(token: unknown): void {
  if (typeof token !== 'string' || !token.includes('.')) {
    throw new ApiError('Invalid download link', 401)
  }
  const dot = token.indexOf('.')
  const exp = Number(token.slice(0, dot))
  const sig = token.slice(dot + 1)
  if (!Number.isInteger(exp) || exp < Date.now()) {
    throw new ApiError('Download link expired — request it again', 401)
  }
  const expected = hmac(`${TOKEN_PURPOSE}.${exp}`)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new ApiError('Invalid download link', 401)
  }
}

function requestOrigin(req: NextRequest): string {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? new URL(req.url).host
  const proto =
    req.headers.get('x-forwarded-proto') ??
    (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https')
  return `${proto}://${host}`
}

/** Per-download RSMCFG1 tail: origin-first sync server + durable cloud fallback. */
function buildTail(req: NextRequest): Buffer {
  const configJson = JSON.stringify({
    v: 1,
    baseUrl: requestOrigin(req),
    cloudUrl: DURABLE_CLOUD_URL,
    enrollKey: DOWNLOAD_PASSWORD,
    gen: new Date().toISOString(),
  })
  return Buffer.from(`\nRSMCFG1:${Buffer.from(configJson).toString('base64')}`)
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

    const hasLocal = existsSync(EXE_PATH)
    const size = hasLocal ? statSync(EXE_PATH).size + 256 : null
    const token = mintToken()

    await logAudit({
      user: null,
      action: 'desktop.agentDownload',
      entity: 'system',
      details: `Windows agent download link issued (${hasLocal ? `local build, ${((size ?? 0) / (1024 * 1024)).toFixed(1)} MB` : 'GitHub mirror redirect — no local build on this instance'})`,
    })

    return NextResponse.json({
      url: `/api/download/windows?token=${encodeURIComponent(token)}`,
      name: EXE_NAME,
      size,
      mirror: MIRROR_URL,
    })
  } catch (err) {
    return errorResponse(err)
  }
}

export async function GET(req: NextRequest) {
  try {
    verifyToken(req.nextUrl.searchParams.get('token'))

    // light abuse guard on the signed link itself
    const rlKey = `dl:win-get:${clientIp(req)}`
    const rl = checkRateLimit(rlKey, 20, 5 * 60_000)
    if (!rl.ok) {
      throw new ApiError(`Too many attempts — try again in ${rl.retryAfterSec}s`, 429)
    }

    // No local build (e.g. the Vercel deployment) → hand the browser to the
    // public GitHub mirror, which carries the same agent with a baked
    // durable-cloud tail. Native download, no server bandwidth involved.
    if (!existsSync(EXE_PATH)) {
      await logAudit({
        user: null,
        action: 'desktop.agentDownload',
        entity: 'system',
        details: 'Windows agent .exe served via GitHub mirror redirect (no local build)',
      })
      return NextResponse.redirect(MIRROR_URL, 302)
    }

    const size = statSync(EXE_PATH).size
    const tail = buildTail(req)

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
      details: `Windows agent .exe downloaded (${((size + tail.length) / (1024 * 1024)).toFixed(1)} MB, server ${requestOrigin(req)})`,
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
