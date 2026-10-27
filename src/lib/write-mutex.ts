/**
 * r31 audit fix — process-local write-serialization for SQLite.
 *
 * WHY: SQLite allows exactly ONE writer at a time. With N concurrent
 * write transactions the busy handler devolves into a backoff storm
 * (each waiter sleeps 1→100 ms, re-probes, loses the race to another
 * waiter) — the r31 stress test measured 8 concurrent order-creates
 * taking ~60 s TOGETHER while each takes 25 ms alone. Serializing the
 * transactions in JavaScript removes the storm entirely: waiters queue
 * cheaply on a promise chain, each transaction runs uncontended, and
 * N concurrent writers complete in ~N × single-tx-time.
 *
 * Scope: fair FIFO mutex, process-local (dev server, packaged desktop,
 * and each serverless instance serialize their own writes — exactly what
 * a single-writer database wants). Cloud Postgres is unaffected
 * functionally; worst case it mildly batches writes per instance.
 *
 * Usage:
 *   const order = await withWriteLock(() => db.$transaction(async (tx) => { ... }))
 */

let tail: Promise<unknown> = Promise.resolve()

/**
 * Run `fn` exclusively with respect to every other `withWriteLock` call
 * in this process. FIFO-fair (the promise chain preserves arrival order),
 * failure-isolated (a rejected fn never poisons the chain), and
 * re-entrancy-safe for the common read-then-write pattern OUTSIDE the
 * lock (the lock only guards what you wrap).
 */
export function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn)
  // keep the chain alive regardless of fn's outcome
  tail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}
