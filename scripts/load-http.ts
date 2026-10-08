/**
 * R14 Layer-2 HTTP load test — hits the LIVE dev server (:3000) over HTTP
 * with realistic terminal traffic (read-heavy + takeaway create/cancel
 * writes; created ids are printed for DB cleanup afterwards).
 *
 * Usage: bun scripts/load-http.ts <duration_seconds> <concurrency>
 */
import { readFileSync } from 'node:fs'

const BASE = 'http://localhost:3000'
const TOKEN = readFileSync('/tmp/rsm-token.txt', 'utf8').trim()
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

const duration = Number(process.argv[2] ?? 30)
const concurrency = Number(process.argv[3] ?? 6)

type Sample = { op: string; ms: number; ok: boolean; status: number }

async function timed(op: string, url: string, init?: RequestInit): Promise<{ s: Sample; body?: unknown }> {
  const t0 = performance.now()
  try {
    const res = await fetch(url, { ...init, headers: H })
    const ms = performance.now() - t0
    let body: unknown
    try {
      body = await res.json()
    } catch {}
    return { s: { op, ms, ok: res.status < 400, status: res.status }, body }
  } catch {
    return { s: { op, ms: performance.now() - t0, ok: false, status: 0 } }
  }
}

async function main(): Promise<void> {
  const samples: Sample[] = []
  const createdIds: number[] = []
  const deadline = Date.now() + duration * 1000
  let round = 0

  async function worker(): Promise<void> {
    while (Date.now() < deadline) {
      round++
      const isWrite = round % 4 === 0 // ~25% of rounds exercise the write path
      if (isWrite) {
        const { s, body } = await timed('order_create+cancel', `${BASE}/api/orders`, {
          method: 'POST',
          body: JSON.stringify({
            orderType: 'takeaway',
            guests: 1,
            items: [{ productId: 20, quantity: 1, unitPrice: 65, course: 'main' }],
          }),
        })
        samples.push(s)
        const order = (body as { order?: { id?: number } } | undefined)?.order
        if (order?.id) {
          createdIds.push(order.id)
          const c = await timed('order_cancel', `${BASE}/api/orders/${order.id}/cancel`, {
            method: 'POST',
            body: JSON.stringify({ reason: 'http load test' }),
          })
          samples.push(c.s)
        }
      } else {
        // the screens every terminal polls
        const rs = await Promise.all([
          timed('products', `${BASE}/api/products`),
          timed('orders_open', `${BASE}/api/orders?status=open`),
          timed('floorplans', `${BASE}/api/floorplans`),
          timed('vision_overview', `${BASE}/api/vision/overview`),
        ])
        samples.push(...rs.map((r) => r.s))
      }
      await new Promise((r) => setTimeout(r, 60)) // terminal think-time
    }
  }

  const t0 = Date.now()
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  const wall = (Date.now() - t0) / 1000

  const byOp: Record<string, { n: number; ok: number; lat: number[]; statuses: Record<number, number> }> = {}
  for (const s of samples) {
    const o = (byOp[s.op] ??= { n: 0, ok: 0, lat: [], statuses: {} })
    o.n++
    if (s.ok) o.ok++
    o.lat.push(s.ms)
    o.statuses[s.status] = (o.statuses[s.status] ?? 0) + 1
  }
  const pct = (a: number[], p: number) =>
    a
      .slice()
      .sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] ?? 0
  const out: Record<string, unknown> = {
    layer: 'http',
    concurrency,
    durationSec: Math.round(wall * 10) / 10,
    totalRequests: samples.length,
    reqPerSec: Math.round((samples.length / wall) * 10) / 10,
    errors: samples.filter((s) => !s.ok).length,
    createdOrderIds: createdIds,
    endpoints: {},
  }
  for (const [op, o] of Object.entries(byOp)) {
    ;(out.endpoints as Record<string, unknown>)[op] = {
      n: o.n,
      ok: o.ok,
      p50ms: Math.round(pct(o.lat, 50) * 10) / 10,
      p95ms: Math.round(pct(o.lat, 95) * 10) / 10,
      p99ms: Math.round(pct(o.lat, 99) * 10) / 10,
      maxMs: Math.round(Math.max(...o.lat) * 10) / 10,
      statuses: o.statuses,
    }
  }
  console.log(JSON.stringify(out, null, 1))
}

main()
