// ─── Desktop agent downloads — shared password-gated route factory ───
//
// r34 introduced the two-transport download for the Windows agent
// (POST password → signed GET link; GitHub Release mirror as the
// always-on fallback). r36 factors it into a factory so the macOS
// (Intel x64) agent download behaves identically:
//
//   POST { password }        → session + password gate → returns JSON
//                              { url, name, size, mirror } where `url` is a
//                              short-lived signed GET link and `mirror` is
//                              the public GitHub Release asset.
//   GET  ?token=<exp>.<sig>  → verifies the stateless HMAC token (no server
//                              state — works across Vercel lambdas), then:
//                                · streams the LOCAL artifact (optionally
//                                  with a per-download RSMCFG1 tail — the
//                                  Windows .exe PE-overlay), or
//                                · 302-redirects to the GitHub mirror when
//                                  no local artifact exists (Vercel: the
//                                  builds are large and gitignored by
//                                  design — the mirror carries the baked
//                                  durable-cloud config).
//
// Platforms: 'windows' (per-download tail appended at stream time) and
// 'macos' (a .zip containing the installer .app — streamed as-is, the
// bootstrap config rides as a side-car resource inside the bundle because
// the Mach-O code signature must remain the last thing in the binary).

import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, statSync } from 'node:fs'

import { ApiError, errorResponse, requireAuth } from '@/lib/auth'
import { logAudit } from '@/lib/audit'
import { checkRateLimit, clientIp } from '@/lib/rate-limit'

/** Durable production hub (Vercel + Neon + Turso + Inngest + GitHub). */
const DURABLE_CLOUD_URL = process.env.VERCEL_PROD_URL ?? 'https://wedjatrsm-tonsy.vercel.app'
const DOWNLOAD_PASSWORD = process.env.DESKTOP_DOWNLOAD_PASSWORD ?? process.env.WINDOWS_DOWNLOAD_PASSWORD ?? '180787'

/** Signed-link lifetime (ms). */
const TOKEN_TTL_MS = 10 * 60_000
/** POST attempts / GET redemptions per IP per 5 minutes. */
const POST_RATE = { limit: 10, windowMs: 5 * 60_000 }
const GET_RATE = { limit: 20, windowMs: 5 * 60_000 }

export type DesktopDownloadOptions = {
  /** this route's own path (used to mint the signed GET link) */
  routePath: string
  /** absolute path of the local artifact (absent on the Vercel deployment) */
  artifactPath: string
  /** filename reported to the browser */
  artifactName: string
  /** public GitHub Release mirror (baked durable-cloud config) */
  mirrorUrl: string
  /** token purpose — distinct per platform so links cannot be cross-used */
  tokenPurpose: string
  /** rate-limit key namespace (e.g. 'win' / 'mac') */
  rateKey: string
  /** audit + error label (e.g. 'Windows agent .exe') */
  label: string
  /** bytes appended to the per-download tail (Windows PE overlay only) */
  tailBytes?: number
  /** optional per-download config tail appended while streaming */
  buildTail?: (req: NextRequest) => Buffer
}

function hmac(payload: string): string {
  return createHmac('sha256', process.env.JWT_SECRET ?? 'rms-dev-secret').update(payload).digest('base64url')
}

/** Stateless single-purpose download token: `<exp>.<base64url hmac>`. */
function mintToken(purpose: string): string {
  const exp = Date.now() + TOKEN_TTL_MS
  return `${exp}.${hmac(`${purpose}.${exp}`)}`
}

function verifyToken(purpose: string, token: unknown): void {
  if (typeof token !== 'string' || !token.includes('.')) {
    throw new ApiError('Invalid download link', 401)
  }
  const dot = token.indexOf('.')
  const exp = Number(token.slice(0, dot))
  const sig = token.slice(dot + 1)
  if (!Number.isInteger(exp) || exp < Date.now()) {
    throw new ApiError('Download link expired — request it again', 401)
  }
  const expected = hmac(`${purpose}.${exp}`)
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
export function buildWindowsConfigTail(req: NextRequest): Buffer {
  const configJson = JSON.stringify({
    v: 1,
    baseUrl: requestOrigin(req),
    cloudUrl: DURABLE_CLOUD_URL,
    enrollKey: DOWNLOAD_PASSWORD,
    gen: new Date().toISOString(),
  })
  return Buffer.from(`\nRSMCFG1:${Buffer.from(configJson).toString('base64')}`)
}

/** Builds the { GET, POST } route handlers for one platform's agent download. */
export function createDesktopDownloadRoute(opts: DesktopDownloadOptions) {
  const hasLocal = () => existsSync(opts.artifactPath)
  const localSize = () => statSync(opts.artifactPath).size + (opts.tailBytes ?? 0)

  async function POST(req: NextRequest) {
    try {
      // any signed-in staff member (waiter, cashier, manager…) — the password
      // is the actual gate; the session just keeps the URL off the open web.
      await requireAuth(req)

      // brute-force guard per IP
      const rlKey = `dl:${opts.rateKey}:${clientIp(req)}`
      const rl = checkRateLimit(rlKey, POST_RATE.limit, POST_RATE.windowMs)
      if (!rl.ok) {
        throw new ApiError(`Too many attempts — try again in ${rl.retryAfterSec}s`, 429)
      }

      const body = (await req.json().catch(() => ({}))) as { password?: unknown }
      const password = String(body?.password ?? '')
      if (password !== DOWNLOAD_PASSWORD) {
        await new Promise((resolve) => setTimeout(resolve, 600))
        throw new ApiError('Incorrect download password', 403)
      }

      const local = hasLocal()
      const size = local ? localSize() : null
      const token = mintToken(opts.tokenPurpose)

      await logAudit({
        user: null,
        action: 'desktop.agentDownload',
        entity: 'system',
        details: `${opts.label} download link issued (${local ? `local build, ${((size ?? 0) / (1024 * 1024)).toFixed(1)} MB` : 'GitHub mirror redirect — no local build on this instance'})`,
      })

      return NextResponse.json({
        url: `${opts.routePath}?token=${encodeURIComponent(token)}`,
        name: opts.artifactName,
        size,
        mirror: opts.mirrorUrl,
      })
    } catch (err) {
      return errorResponse(err)
    }
  }

  async function GET(req: NextRequest) {
    try {
      verifyToken(opts.tokenPurpose, req.nextUrl.searchParams.get('token'))

      // light abuse guard on the signed link itself
      const rlKey = `dl:${opts.rateKey}-get:${clientIp(req)}`
      const rl = checkRateLimit(rlKey, GET_RATE.limit, GET_RATE.windowMs)
      if (!rl.ok) {
        throw new ApiError(`Too many attempts — try again in ${rl.retryAfterSec}s`, 429)
      }

      // No local build (e.g. the Vercel deployment) → hand the browser to the
      // public GitHub mirror, which carries the same agent with a baked
      // durable-cloud config. Native download, no server bandwidth involved.
      if (!hasLocal()) {
        await logAudit({
          user: null,
          action: 'desktop.agentDownload',
          entity: 'system',
          details: `${opts.label} served via GitHub mirror redirect (no local build)`,
        })
        return NextResponse.redirect(opts.mirrorUrl, 302)
      }

      const size = statSync(opts.artifactPath).size
      const tail = opts.buildTail ? opts.buildTail(req) : null

      const fileBody = new ReadableStream<Uint8Array>({
        async start(controller) {
          const nodeStream = createReadStream(opts.artifactPath)
          for await (const chunk of nodeStream) {
            controller.enqueue(new Uint8Array(chunk as Buffer))
          }
          if (tail) controller.enqueue(new Uint8Array(tail))
          controller.close()
        },
      })

      await logAudit({
        user: null,
        action: 'desktop.agentDownload',
        entity: 'system',
        details: `${opts.label} downloaded (${((size + (tail?.length ?? 0)) / (1024 * 1024)).toFixed(1)} MB, server ${requestOrigin(req)})`,
      })

      return new Response(fileBody, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${opts.artifactName}"`,
          'Content-Length': String(size + (tail?.length ?? 0)),
          'Cache-Control': 'no-store',
        },
      })
    } catch (err) {
      return errorResponse(err)
    }
  }

  return { GET, POST }
}
