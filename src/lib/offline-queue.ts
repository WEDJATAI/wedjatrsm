// ─── R13: offline draft queue (PWA companion) ────────────────────────
// When the terminal loses connectivity, the POS "send to kitchen" action
// enqueues the raw order-create payload in localStorage instead of failing.
// On reconnect the queue replays sequentially (FIFO) through the same API,
// then invalidates React Query caches so every open view refreshes.
//
// Honest scope: queued actions are order CREATIONS only (add-items and
// payment flows refuse to queue — they need fresh server state). The POS
// clears the draft on enqueue, exactly like the online path, so a replay
// cannot duplicate an order the waiter still sees.

'use client'

export type QueuedOrderAction = {
  id: string
  url: string
  method: string
  body: unknown
  label: string
  queuedAt: number
}

const QUEUE_KEY = 'rms-offline-queue'
const QUEUE_EVENT = 'rms-offline-queue-change'

function readQueue(): QueuedOrderAction[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(QUEUE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (a): a is QueuedOrderAction =>
        !!a && typeof a === 'object' && typeof (a as QueuedOrderAction).id === 'string',
    )
  } catch {
    return []
  }
}

function writeQueue(queue: QueuedOrderAction[]): void {
  try {
    window.localStorage.setItem(QUEUE_KEY, JSON.stringify(queue))
  } catch {
    // storage unavailable — the action is lost with the tab (documented)
  }
  window.dispatchEvent(new Event(QUEUE_EVENT))
}

/** Queue an action while offline (id via crypto.randomUUID fallback). */
export function enqueueOfflineAction(
  action: Omit<QueuedOrderAction, 'id' | 'queuedAt'>,
): QueuedOrderAction {
  const queue = readQueue()
  const full: QueuedOrderAction = {
    ...action,
    id:
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `q-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    queuedAt: Date.now(),
  }
  writeQueue([...queue, full])
  return full
}

export function offlineQueueSnapshot(): QueuedOrderAction[] {
  return readQueue()
}

export function offlineQueueCount(): number {
  return readQueue().length
}

export function subscribeOfflineQueue(onChange: () => void): () => void {
  window.addEventListener(QUEUE_EVENT, onChange)
  return () => window.removeEventListener(QUEUE_EVENT, onChange)
}

export type FlushResult = { sent: number; failed: number }

/**
 * Replay the queue in order. Runs at most once at a time (module-level
 * guard). `fetchImpl` is injectable for tests/edge cases; the default is
 * the platform fetcher contract ({ error } JSON on failure).
 *
 * "sent" counts actions consumed (delivered OR permanently rejected by a
 * 4xx — those are dropped with a console trace since retrying cannot
 * help, e.g. the table was taken while offline); "failed" counts actions
 * that stay queued (network/5xx — retried on the next reconnect).
 */
let flushing = false
export async function flushOfflineQueue(
  fetchImpl: (action: QueuedOrderAction) => Promise<void> = defaultReplay,
): Promise<FlushResult> {
  if (flushing) return { sent: 0, failed: 0 }
  flushing = true
  try {
    let sent = 0
    let failed = 0
    // replay one-by-one: a failure keeps the action (and the ones behind
    // it) queued for the next reconnect — order preservation matters.
    while (true) {
      const queue = readQueue()
      if (queue.length === 0) break
      const action = queue[0]
      try {
        await fetchImpl(action)
        writeQueue(readQueue().slice(1))
        sent++
      } catch {
        failed++
        break // keep the rest queued in order
      }
    }
    return { sent, failed }
  } finally {
    flushing = false
  }
}

async function defaultReplay(action: QueuedOrderAction): Promise<void> {
  const res = await fetch(action.url, {
    method: action.method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(action.body),
    credentials: 'same-origin',
  })
  if (!res.ok) {
    // 4xx = the server rejected the payload (e.g. table taken since) —
    // retrying will not help. 5xx / network errors keep it queued.
    if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      // drop permanently-rejected actions with a console trace (the toast
      // for the flush reports failures; staff resolves in the POS)
      console.warn('[offline-queue] action rejected by server, dropping', action.id, res.status)
      return
    }
    throw new Error(`replay failed (${res.status})`)
  }
}
