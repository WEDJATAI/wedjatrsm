// /api/agent/cloud-status — live health of the five cloud platforms.
//
// Device-authenticated (a registered agent) or admin/settings session (the
// Sync Center UI). Server-side checks with short timeouts so a down platform
// never blocks the response; results are cached for 60 seconds (the agent
// polls on every sync cycle). Secrets NEVER ride the response — only the
// human-readable status, detail and latency.
import { NextRequest, NextResponse } from 'next/server'

import { errorResponse } from '@/lib/auth'
import { requireSessionOrDevice } from '@/lib/hybrid-auth'
import { isTursoConfigured, getTursoClient } from '@/lib/turso'
import { db } from '@/lib/db'

export type PlatformStatus = {
  id: 'github' | 'vercel' | 'turso' | 'neon' | 'inngest'
  label: string
  status: 'connected' | 'configured' | 'unreachable' | 'not-configured'
  detail: string
  latencyMs: number | null
}

const CACHE_TTL_MS = 60_000
let cache: { at: number; payload: { checkedAt: string; platforms: PlatformStatus[] } } | null = null

const CHECK_TIMEOUT_MS = 5_000

function requestOrigin(req: NextRequest): string {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? new URL(req.url).host
  const proto =
    req.headers.get('x-forwarded-proto') ??
    (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https')
  return `${proto}://${host}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function timedHead(url: string): Promise<{ ok: boolean; status: number; latencyMs: number }> {
  const started = Date.now()
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) })
    return { ok: res.ok, status: res.status, latencyMs: Date.now() - started }
  } catch {
    return { ok: false, status: 0, latencyMs: Date.now() - started }
  }
}

async function checkGithub(): Promise<PlatformStatus> {
  const repo = process.env.GITHUB_REPO ?? 'WEDJATAI/wedjatrsm'
  try {
    const started = Date.now()
    const res = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    })
    const latencyMs = Date.now() - started
    if (res.ok) {
      const data = (await res.json().catch(() => null)) as { pushed_at?: string } | null
      const pushed = data?.pushed_at ? ` — last push ${String(data.pushed_at).slice(0, 10)}` : ''
      return { id: 'github', label: 'GitHub', status: 'connected', detail: `${repo}${pushed}`, latencyMs }
    }
    return {
      id: 'github',
      label: 'GitHub',
      status: 'unreachable',
      detail: `${repo} — HTTP ${res.status}${res.status === 404 ? ' (private repo without token?)' : ''}`,
      latencyMs,
    }
  } catch {
    return { id: 'github', label: 'GitHub', status: 'unreachable', detail: `${repo} — no response`, latencyMs: null }
  }
}

async function checkVercel(origin: string): Promise<PlatformStatus> {
  const target = process.env.VERCEL_PROD_URL ?? origin
  const res = await timedHead(target)
  if (res.ok) {
    return {
      id: 'vercel',
      label: 'Vercel',
      status: 'connected',
      detail: target === origin ? 'this deployment' : target.replace(/^https?:\/\//, ''),
      latencyMs: res.latencyMs,
    }
  }
  return {
    id: 'vercel',
    label: 'Vercel',
    status: 'unreachable',
    detail: `${target.replace(/^https?:\/\//, '')} — HTTP ${res.status || 'no response'}`,
    latencyMs: res.latencyMs,
  }
}

async function checkTurso(): Promise<PlatformStatus> {
  if (!isTursoConfigured()) {
    return {
      id: 'turso',
      label: 'Turso',
      status: 'not-configured',
      detail: 'replica credentials not set on this instance',
      latencyMs: null,
    }
  }
  const started = Date.now()
  try {
    await Promise.race([
      getTursoClient().execute('SELECT 1'),
      sleep(6_000).then(() => Promise.reject(new Error('timeout'))),
    ])
    return {
      id: 'turso',
      label: 'Turso',
      status: 'connected',
      detail: 'analytics replica — SELECT 1 ok',
      latencyMs: Date.now() - started,
    }
  } catch {
    return { id: 'turso', label: 'Turso', status: 'unreachable', detail: 'replica query failed', latencyMs: null }
  }
}

async function checkNeon(): Promise<PlatformStatus> {
  const primary = process.env.DATABASE_URL ?? ''
  if (primary.startsWith('postgres')) {
    const started = Date.now()
    try {
      await Promise.race([db.$queryRaw`SELECT 1`, sleep(6_000).then(() => Promise.reject(new Error('timeout')))])
      return {
        id: 'neon',
        label: 'Neon',
        status: 'connected',
        detail: 'primary datastore — SELECT 1 ok',
        latencyMs: Date.now() - started,
      }
    } catch {
      return { id: 'neon', label: 'Neon', status: 'unreachable', detail: 'primary datastore query failed', latencyMs: null }
    }
  }
  if (process.env.NEON_DATABASE_URL) {
    return {
      id: 'neon',
      label: 'Neon',
      status: 'configured',
      detail: 'primary datastore of the Vercel production deployment',
      latencyMs: null,
    }
  }
  return {
    id: 'neon',
    label: 'Neon',
    status: 'not-configured',
    detail: 'runs as primary datastore on the Vercel production deployment',
    latencyMs: null,
  }
}

async function checkInngest(): Promise<PlatformStatus> {
  const hasKey = Boolean(process.env.INNGEST_SIGNING_KEY || process.env.INNGEST_EVENT_KEY)
  if (!hasKey) {
    return {
      id: 'inngest',
      label: 'Inngest',
      status: 'not-configured',
      detail: 'no signing key on this instance',
      latencyMs: null,
    }
  }
  const res = await timedHead('https://app.inngest.com')
  return {
    id: 'inngest',
    label: 'Inngest',
    status: res.ok ? 'connected' : 'unreachable',
    detail: res.ok ? 'background jobs — signing key present' : 'cloud unreachable',
    latencyMs: res.latencyMs,
  }
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireSessionOrDevice(req, ['settings'])
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
      return NextResponse.json(cache.payload)
    }
    const origin = requestOrigin(req)
    const platforms = await Promise.all([checkGithub(), checkVercel(origin), checkTurso(), checkNeon(), checkInngest()])
    const payload = { checkedAt: new Date().toISOString(), platforms }
    cache = { at: Date.now(), payload }
    return NextResponse.json(payload)
  } catch (err) {
    return errorResponse(err)
  }
}
