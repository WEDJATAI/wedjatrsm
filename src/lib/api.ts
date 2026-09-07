'use client'

// ─── Client-side API helpers (used with TanStack Query) ──────────────

/** Default fetcher for TanStack Query: `useQuery({ queryKey: [...], queryFn: fetcher })` */
export async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'same-origin' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`)
  }
  return data as T
}

export class ApiRequestError extends Error {}

/** POST/PUT/DELETE helper that throws readable errors and returns parsed JSON. */
export async function apiFetch<T>(
  url: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const { method = 'POST', body } = options
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new ApiRequestError((data as { error?: string }).error ?? `Request failed (${res.status})`)
  }
  return data as T
}
