/**
 * P6 failure-simulation service — two deliberately broken "cloud" endpoints
 * for testing the hybrid engine's failure paths against a controlled peer:
 *
 *   port 3101 — CLOUD-500: every request answers HTTP 500 immediately
 *               (server error / backend DB down at the edge)
 *   port 3102 — CLOUD-BLACKHOLE: accepts the TCP connection and NEVER
 *               responds (network partition / hung load balancer) — the
 *               client's AbortController timeout is the only way out
 *
 * Any path, any method. Responses are JSON like the real hybrid API so the
 * client's res.json() parse never throws before the status check.
 *
 * Start:  cd mini-services/fail-sim && bun run dev   (bun --hot auto-restart)
 */
const LOG = (port: string, method: string, path: string) =>
  console.log(`[fail-sim ${port}] ${method} ${path}`)

Bun.serve({
  port: 3101,
  fetch(req) {
    LOG('3101', req.method, new URL(req.url).pathname)
    return new Response(
      JSON.stringify({ error: 'simulated internal server error' }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    )
  },
})
console.log('[fail-sim] CLOUD-500 listening on :3101 (every request → 500)')

Bun.serve({
  port: 3102,
  fetch(req) {
    LOG('3102', req.method, new URL(req.url).pathname)
    // accept, read the body, then never answer — the connection hangs until
    // the client's AbortController fires (HYBRID_PUSH_TIMEOUT_MS = 15 s)
    return new Promise(() => {}) as unknown as Response
  },
})
console.log('[fail-sim] CLOUD-BLACKHOLE listening on :3102 (never responds)')
