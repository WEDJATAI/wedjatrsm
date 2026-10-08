'use client'

// ─── Client-side API helpers (used with TanStack Query) ──────────────

const TOKEN_STORAGE_KEY = 'rms_session_token'

/**
 * Persist the raw session token (returned by /api/auth/login) for the
 * Bearer-header fallback. Used when cookies cannot be sent back by the
 * browser (e.g. the app runs inside a cross-site preview iframe).
 */
export function setSessionToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token)
  } catch {
    // storage unavailable (private mode etc.) — cookie flow still applies
  }
}

export function clearSessionToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY)
  } catch {
    // ignore
  }
}

export function getSessionToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY)
  } catch {
    return null
  }
}

function authHeaders(): HeadersInit | undefined {
  const token = getSessionToken()
  return token ? { Authorization: `Bearer ${token}` } : undefined
}

/** Default fetcher for TanStack Query: `useQuery({ queryKey: [...], queryFn: fetcher })` */
export async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    credentials: 'same-origin',
    headers: authHeaders(),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`)
  }
  return data as T
}

export class ApiRequestError extends Error {}

/** R14: authenticated binary download (backups, exports) → Blob. */
export async function apiFetchBlob(url: string): Promise<Blob> {
  const res = await fetch(url, {
    method: 'GET',
    headers: authHeaders(),
    credentials: 'same-origin',
  })
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string }
    throw new ApiRequestError(data.error ?? `Request failed (${res.status})`)
  }
  return res.blob()
}

/** POST/PUT/DELETE helper that throws readable errors and returns parsed JSON. */
export async function apiFetch<T>(
  url: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const { method = 'POST', body } = options
  const res = await fetch(url, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...authHeaders(),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new ApiRequestError((data as { error?: string }).error ?? `Request failed (${res.status})`)
  }
  return data as T
}
