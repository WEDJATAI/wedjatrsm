/**
 * R30 hybrid sync — HTTP client for the cloud instance.
 *
 * Thin fetch wrapper with a hard timeout (AbortController) and the two
 * device-auth headers. NEVER logs the device key or the full request body —
 * errors are returned, not thrown, so callers classify them (auth vs network
 * vs malformed) without try/catch noise.
 *
 * targetUrl is an ABSOLUTE URL to the cloud instance (AppSetting
 * sync.targetUrl — shared with the legacy rsm-sync/1 engine by design: one
 * "where is my cloud" setting per installation).
 */

export type HybridFetchOptions = {
  method: 'GET' | 'POST'
  body?: unknown
  deviceId: string
  deviceKey: string
  timeoutMs: number
}

export type HybridFetchResult = {
  ok: boolean
  status: number
  json: unknown | null
  error?: string
}

export async function hybridFetch(
  targetUrl: string,
  path: string,
  opts: HybridFetchOptions,
): Promise<HybridFetchResult> {
  const base = targetUrl.trim().replace(/\/+$/, '')
  const url = `${base}${path}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs)
  try {
    const res = await fetch(url, {
      method: opts.method,
      signal: controller.signal,
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        'x-hybrid-device': opts.deviceId,
        'x-hybrid-key': opts.deviceKey,
      },
      body: opts.method === 'POST' ? JSON.stringify(opts.body ?? {}) : undefined,
    })
    let json: unknown | null = null
    try {
      json = await res.json()
    } catch {
      json = null // non-JSON body (proxy html, empty 204…) — status still rules
    }
    return { ok: res.ok, status: res.status, json }
  } catch (err) {
    // aborted → timeout; otherwise a network-level failure (DNS, refused…)
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, status: 0, json: null, error: message.slice(0, 120) }
  } finally {
    clearTimeout(timer)
  }
}
