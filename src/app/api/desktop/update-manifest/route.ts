// /api/desktop/update-manifest — r68 IN-PLACE desktop app updates.
//
// The desktop agent polls this (device-authenticated, like its other hybrid
// calls) to learn whether a NEWER app payload is published. When the version
// is newer than the installed payload-version.json, the agent downloads the
// payload zip, overlays the installed platform (preserving the live database,
// .env identity and node_modules), rebuilds and restarts the supervised
// server — new application code reaches the RUNNING desktop with zero
// re-downloading of installers (owner directive r68 item 4).
//
// Source of truth, in priority order:
//  1. env overrides (DESKTOP_PAYLOAD_VERSION / _SHA256 / _SIZE / _URL) — set
//     at deploy time for exact pinning;
//  2. the GitHub release `platform-setup-v2` (the same release that carries
//     the installers): the version is parsed from the release NAME
//     ("… r68 · v2.7.0 …") and the rsm-platform-payload.zip asset provides
//     url/size/digest.
// Results are cached for 5 minutes (every agent polls this; the GitHub API
// has anonymous rate limits). Secrets never ride the response.
import { NextRequest, NextResponse } from 'next/server'

import { errorResponse } from '@/lib/auth'
import { requireSessionOrDevice } from '@/lib/hybrid-auth'

export const dynamic = 'force-dynamic'

export type UpdateManifest = {
  available: boolean
  version: string | null
  sha256: string | null
  size: number | null
  url: string | null
  checkedAt: string
  source: 'env' | 'github-release' | 'none'
  note?: string
}

const CACHE_TTL_MS = 5 * 60_000
const GITHUB_TIMEOUT_MS = 6_000
let cache: { at: number; manifest: UpdateManifest } | null = null

const RELEASE_TAG = 'platform-setup-v2'
const PAYLOAD_ASSET_NAME = 'rsm-platform-payload.zip'

type GhAsset = {
  name: string
  size: number
  browser_download_url: string
  digest?: string | null
  updated_at?: string
}

type GhRelease = {
  name?: string
  tag_name?: string
  assets?: GhAsset[]
}

/** Parse "vX.Y.Z" (anywhere in a string) → [X, Y, Z]; null when absent. */
function parseVersion(s: string | null | undefined): [number, number, number] | null {
  if (!s) return null
  const m = s.match(/v?(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

async function fetchFromGithub(): Promise<UpdateManifest> {
  const repo = process.env.GITHUB_REPO ?? 'WEDJATAI/wedjatrsm'
  const base: UpdateManifest = {
    available: false,
    version: null,
    sha256: null,
    size: null,
    url: null,
    checkedAt: new Date().toISOString(),
    source: 'none',
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${RELEASE_TAG}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
      },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    })
    if (!res.ok) {
      return { ...base, note: `release ${RELEASE_TAG}: HTTP ${res.status}` }
    }
    const rel = (await res.json().catch(() => null)) as GhRelease | null
    if (!rel) return { ...base, note: 'release payload unparseable' }
    const version = parseVersion(rel.name ?? '') ?? parseVersion(rel.tag_name ?? '')
    const asset = (rel.assets ?? []).find((a) => a.name === PAYLOAD_ASSET_NAME)
    if (!version || !asset) {
      return { ...base, note: version ? 'payload asset not found on the release' : 'no version in the release name' }
    }
    const digest = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : null
    return {
      available: true,
      version: version.join('.'),
      sha256: digest,
      size: asset.size,
      url: asset.browser_download_url,
      checkedAt: new Date().toISOString(),
      source: 'github-release',
    }
  } catch (err) {
    return { ...base, note: `github unreachable: ${err instanceof Error ? err.message : String(err)}` }
  }
}

async function buildManifest(): Promise<UpdateManifest> {
  // 1) env pinning (deploy-time exact control)
  const envVersion = process.env.DESKTOP_PAYLOAD_VERSION
  if (envVersion && parseVersion(envVersion)) {
    return {
      available: true,
      version: envVersion,
      sha256: process.env.DESKTOP_PAYLOAD_SHA256 ?? null,
      size: process.env.DESKTOP_PAYLOAD_SIZE ? Number(process.env.DESKTOP_PAYLOAD_SIZE) : null,
      url:
        process.env.DESKTOP_PAYLOAD_URL ??
        `https://github.com/${process.env.GITHUB_REPO ?? 'WEDJATAI/wedjatrsm'}/releases/download/${RELEASE_TAG}/${PAYLOAD_ASSET_NAME}`,
      checkedAt: new Date().toISOString(),
      source: 'env',
    }
  }
  // 2) the GitHub release (self-maintaining — every round updates the release)
  return fetchFromGithub()
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireSessionOrDevice(req, ['settings'])
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
      return NextResponse.json(cache.manifest)
    }
    const manifest = await buildManifest()
    cache = { at: Date.now(), manifest }
    return NextResponse.json(manifest)
  } catch (err) {
    return errorResponse(err)
  }
}
