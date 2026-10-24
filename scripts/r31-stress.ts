/**
 * R31 (Task 2-b) — Friday-rush stress simulation against the LIVE dev server.
 *
 * Phases (all HTTP, Bearer admin token; EXCLUDES /api/hybrid/push, /api/sync/*,
 * /api/admin/backup, /api/cron/*, /api/inngest by rule):
 *   0 warmup      10 sequential GETs each of products / tables/status / orders
 *                 (+ ONE create+cancel cycle to warm the write-path compile)
 *   1 read-heavy  60s, 8 workers round-robin: products, tables/status, orders,
 *                 categories, hybrid/status
 *   2 write-path  45s, 6 workers: POST takeaway order → immediate cancel
 *   3 burst       10s, 24 workers alternating products / tables/status
 *   4 reports     15s, 4 workers round-robin: zreport, sales, forecast
 *   5 kds+pos mix 30s, 10 workers: 70% orders, 20% products, 10% write cycle
 *
 * Usage:   NODE_ENV=production bun scripts/r31-stress.ts
 *          (NODE_ENV=production only silences THIS harness's Prisma query
 *           logging — the dev server's own behavior is untouched)
 *
 * Outputs: stdout summary + full list of created order ids
 *          /tmp/r31-stress-results.json       (full metrics)
 *          /tmp/r31-stress-order-ids.json     (created test order ids)
 *          /tmp/r31-stress-baseline.json      (pre-test DB baseline)
 *
 * Write-path product: the briefed productId 20 is NOT in the active catalog
 * (retired demo row) — the harness prefers id 20, falls back to 101 "Arabita"
 * (EGP 110, Pasta, active/sellable, no recipe → no stock side effects).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { db } from '../src/lib/db'

const BASE = 'http://localhost:3000'
const TOKEN_FILE = '/tmp/rsm-tok-manager-login.txt'
const RESULTS_FILE = '/tmp/r31-stress-results.json'
const IDS_FILE = '/tmp/r31-stress-order-ids.json'
const BASELINE_FILE = '/tmp/r31-stress-baseline.json'
const DEV_LOG = '/home/z/my-project/dev.log'
const REQUEST_TIMEOUT_MS = 45_000

const ADMIN = readFileSync(TOKEN_FILE, 'utf8').trim()
const H: Record<string, string> = {
  Authorization: `Bearer ${ADMIN}`,
  'Content-Type': 'application/json',
}

type Sample = { op: string; ms: number; ok: boolean; status: number; err?: string }
type EpStats = {
  n: number
  ok: number
  p50ms: number
  p95ms: number
  p99ms: number
  maxMs: number
  avgMs: number
  reqPerSec: number
  statuses: Record<string, number>
}
type PhaseResult = {
  name: string
  durationSec: number
  totalRequests: number
  reqPerSec: number
  errors: number
  endpoints: Record<string, EpStats>
  errorDigest: string[]
  devLogLinesBefore: number
  devLogLinesAfter: number
}

const pct = (sorted: number[], p: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]

function stats(samples: Sample[], wallSec: number): {
  total: { n: number; errors: number; reqPerSec: number }
  endpoints: Record<string, EpStats>
} {
  const byOp: Record<string, { n: number; ok: number; lat: number[]; statuses: Record<string, number> }> = {}
  for (const s of samples) {
    const o = (byOp[s.op] ??= { n: 0, ok: 0, lat: [], statuses: {} })
    o.n++
    if (s.ok) o.ok++
    o.lat.push(s.ms)
    const key = `${s.status}${s.err ? ` (${s.err})` : ''}`
    o.statuses[key] = (o.statuses[key] ?? 0) + 1
  }
  const endpoints: Record<string, EpStats> = {}
  for (const [op, o] of Object.entries(byOp)) {
    const sorted = o.lat.slice().sort((a, b) => a - b)
    endpoints[op] = {
      n: o.n,
      ok: o.ok,
      p50ms: Math.round(pct(sorted, 50) * 10) / 10,
      p95ms: Math.round(pct(sorted, 95) * 10) / 10,
      p99ms: Math.round(pct(sorted, 99) * 10) / 10,
      maxMs: Math.round(sorted[sorted.length - 1] * 10) / 10,
      avgMs: Math.round((o.lat.reduce((a, b) => a + b, 0) / o.n) * 10) / 10,
      reqPerSec: Math.round((o.n / wallSec) * 10) / 10,
      statuses: o.statuses,
    }
  }
  return {
    total: {
      n: samples.length,
      errors: samples.filter((s) => !s.ok).length,
      reqPerSec: Math.round((samples.length / wallSec) * 10) / 10,
    },
    endpoints,
  }
}

async function timed(op: string, url: string, init?: RequestInit): Promise<{ s: Sample; body?: any }> {
  const t0 = performance.now()
  try {
    const res = await fetch(url, { ...init, headers: H, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    const ms = performance.now() - t0
    let body: any
    try {
      body = await res.json()
    } catch {}
    return { s: { op, ms, ok: res.status >= 200 && res.status < 300, status: res.status }, body }
  } catch (e: any) {
    const ms = performance.now() - t0
    const reason =
      e?.name === 'TimeoutError'
        ? 'timeout'
        : String(e?.cause?.code ?? e?.cause?.message ?? e?.code ?? e?.message ?? 'network error').slice(0, 100)
    return { s: { op, ms, ok: false, status: 0, err: reason } }
  }
}

function capturePs(): { raw: string; nextServerRssKb: number | null } {
  try {
    const pids = execSync("pgrep -f 'next dev|next-server|bun.*dev' | head -5", { encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter(Boolean)
    if (pids.length === 0) return { raw: 'no matching processes', nextServerRssKb: null }
    const raw = execSync(`ps -o pid,rss,vsz,cmd -p ${pids.join(',')} | tail -n +2`, { encoding: 'utf8' }).trim()
    const line = raw.split('\n').find((l) => l.includes('next-server'))
    const rss = line ? Number(line.trim().split(/\s+/)[1]) : null
    return { raw, nextServerRssKb: rss }
  } catch (e) {
    return { raw: 'ps failed: ' + String(e).slice(0, 120), nextServerRssKb: null }
  }
}

const devLogLines = (): number => Number(execSync(`wc -l < ${DEV_LOG}`, { encoding: 'utf8' }).trim())

// ── global state ───────────────────────────────────────────────────
const createdOrders: { id: number; phase: string; qty: number }[] = []
const errorTally = new Map<string, number>()
let criticalAbort = false
let consecutiveNetworkFailures = 0
let activeSamples: Sample[] | null = null

function recordError(s: Sample): void {
  if (s.ok) return
  const key = `${s.op} → HTTP ${s.status}${s.err ? ` (${s.err})` : ''}`
  errorTally.set(key, (errorTally.get(key) ?? 0) + 1)
  if (s.status === 0) {
    consecutiveNetworkFailures++
    if (consecutiveNetworkFailures >= 25) criticalAbort = true
  } else {
    consecutiveNetworkFailures = 0
  }
}

function track(s: Sample): void {
  activeSamples?.push(s)
  if (!s.ok) recordError(s)
}

async function doGet(op: string, path: string): Promise<Sample> {
  const { s } = await timed(op, `${BASE}${path}`)
  track(s)
  return s
}

async function writeCycle(phase: string, P: { id: number; unitPrice: number }): Promise<void> {
  const quantity = 1 + Math.floor(Math.random() * 3) // 1..3
  const { s, body } = await timed(`${phase}:order_create`, `${BASE}/api/orders`, {
    method: 'POST',
    body: JSON.stringify({
      orderType: 'takeaway',
      guests: 1,
      items: [{ productId: P.id, quantity, unitPrice: P.unitPrice, course: 'main' }],
    }),
  })
  track(s)
  if (!s.ok) return
  const id = body?.order?.id
  if (id == null) {
    const key = `${phase}:order_create → 2xx without order.id`
    errorTally.set(key, (errorTally.get(key) ?? 0) + 1)
    return
  }
  createdOrders.push({ id, phase, qty: quantity })
  const c = await timed(`${phase}:order_cancel`, `${BASE}/api/orders/${id}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason: 'r31 stress' }),
  })
  track(c.s)
}

async function runPhase(
  name: string,
  durationSec: number,
  workers: number,
  iterate: (workerIdx: number, iterIdx: number) => Promise<void>,
): Promise<PhaseResult> {
  const devLogLinesBefore = devLogLines()
  const samples: Sample[] = []
  activeSamples = samples
  const deadline = Date.now() + durationSec * 1000
  const t0 = Date.now()

  async function worker(w: number): Promise<void> {
    let i = 0
    while (Date.now() < deadline && !criticalAbort) {
      const before = samples.length
      await iterate(w, i)
      const produced = samples.slice(before)
      // reset the crash detector unless EVERY sample of this iteration was a
      // network-level failure (status 0)
      if (produced.length === 0 || produced.some((s) => s.status !== 0)) consecutiveNetworkFailures = 0
      i++
    }
  }
  await Promise.all(Array.from({ length: workers }, (_, w) => worker(w)))
  activeSamples = null

  const wall = (Date.now() - t0) / 1000
  const { total, endpoints } = stats(samples, wall)
  const digest = [...errorTally.entries()]
    .filter(([k]) => k.startsWith(`${name}:`))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([k, n]) => `${k} ×${n}`)
  for (const k of [...errorTally.keys()]) if (k.startsWith(`${name}:`)) errorTally.delete(k)

  return {
    name,
    durationSec: Math.round(wall * 10) / 10,
    totalRequests: total.n,
    reqPerSec: total.reqPerSec,
    errors: total.errors,
    endpoints,
    errorDigest: digest,
    devLogLinesBefore,
    devLogLinesAfter: devLogLines(),
  }
}

function printPhase(p: PhaseResult): void {
  console.log(
    `\n=== ${p.name} — ${p.totalRequests} reqs in ${p.durationSec}s → ${p.reqPerSec} rps, ${p.errors} error(s) ===`,
  )
  for (const [op, e] of Object.entries(p.endpoints).sort((a, b) => b[1].n - a[1].n)) {
    console.log(
      `  ${op.padEnd(28)} n=${String(e.n).padStart(5)} ok=${String(e.ok).padStart(5)} p50=${String(e.p50ms).padStart(7)}ms p95=${String(e.p95ms).padStart(7)}ms p99=${String(e.p99ms).padStart(7)}ms max=${String(e.maxMs).padStart(8)}ms avg=${String(e.avgMs).padStart(7)}ms rps=${e.reqPerSec}`,
    )
  }
  if (p.errorDigest.length > 0) console.log('  errors: ' + p.errorDigest.join(' | '))
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString()
  const memoryBefore = capturePs()
  const devLogLinesSuiteStart = devLogLines()

  // 0) server liveness (public home, no auth)
  const home = await fetch(`${BASE}/`).catch(() => null)
  if (!home || home.status !== 200) {
    console.error('CRITICAL: dev server not answering 200 on GET / — aborting before any load.')
    process.exit(1)
  }

  // write-path product verification (briefed id 20, fallback 101)
  const catRes = await fetch(`${BASE}/api/products`, { headers: H })
  const cat = (await catRes.json().catch(() => null)) as any
  const list: any[] = Array.isArray(cat) ? cat : (cat?.products ?? cat?.data ?? [])
  let chosen = list.find((p) => p?.id === 20 && p.active)
  let note = 'briefed productId 20 active — used it'
  if (!chosen) {
    chosen = list.find((p) => p?.id === 101 && p.active && p.isSellable)
    note = 'productId 20 NOT in active catalog (retired demo row) — fallback productId 101'
  }
  if (!chosen) throw new Error('No active product found for write-path (neither 20 nor 101)')
  const P = { id: chosen.id, name: chosen.name, unitPrice: chosen.price, course: 'main' }
  console.log(`[r31] write-path product: #${P.id} "${P.name}" EGP ${P.unitPrice} (${note})`)

  // 1) DB baseline (before ANY test writes — same live local SQLite the dev
  //    server uses, read through the same Prisma client)
  const [orderCount, maxIdAgg, cancelledCount, paymentsCount, hybridGroups] = await Promise.all([
    db.order.count(),
    db.order.aggregate({ _max: { id: true } }),
    db.order.count({ where: { status: 'cancelled' } }),
    db.payment.count(),
    db.hybridEvent.groupBy({ by: ['direction', 'status'], _count: { _all: true } }),
  ])
  const baseline = {
    capturedAt: startedAt,
    orderCount,
    maxOrderId: maxIdAgg._max.id ?? null,
    cancelledCount,
    paymentsCount,
    hybridEvents: hybridGroups.map((g) => ({ direction: g.direction, status: g.status, count: g._count._all })),
    deadOutEvents: hybridGroups
      .filter((g) => g.direction === 'out' && g.status === 'dead')
      .reduce((a, g) => a + g._count._all, 0),
    pendingOutEvents: hybridGroups
      .filter((g) => g.direction === 'out' && g.status === 'pending')
      .reduce((a, g) => a + g._count._all, 0),
  }
  writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2))
  console.log(
    `[r31] baseline: orders=${orderCount} (max id ${baseline.maxOrderId}), cancelled=${cancelledCount}, payments=${paymentsCount}, hybrid=${JSON.stringify(baseline.hybridEvents)}`,
  )
  console.log(
    `[r31] dev.log starts at ${devLogLinesSuiteStart} lines; next-server RSS before: ${memoryBefore.nextServerRssKb} KB`,
  )

  // ── PHASE 0: warmup (compile everything the suite touches) ──────
  const warmupLogBefore = devLogLines()
  const warmupSamples: Sample[] = []
  activeSamples = warmupSamples
  const t0 = Date.now()
  for (const ep of ['/api/products', '/api/tables/status', '/api/orders']) {
    for (let i = 0; i < 10; i++) await doGet(`warmup:${ep}`, ep)
  }
  await writeCycle('warmup', P) // warms POST /api/orders + cancel compile
  activeSamples = null
  const warmupWall = (Date.now() - t0) / 1000
  const warmupStats = stats(warmupSamples, warmupWall)
  const warmupResult: PhaseResult = {
    name: 'phase0-warmup (excluded from headline)',
    durationSec: Math.round(warmupWall * 10) / 10,
    totalRequests: warmupStats.total.n,
    reqPerSec: warmupStats.total.reqPerSec,
    errors: warmupStats.total.errors,
    endpoints: warmupStats.endpoints,
    errorDigest: [],
    devLogLinesBefore: warmupLogBefore,
    devLogLinesAfter: devLogLines(),
  }
  printPhase(warmupResult)
  await new Promise((r) => setTimeout(r, 1500))

  const phases: PhaseResult[] = []

  // ── PHASE 1: read-heavy (waiter terminal fleet) ─────────────────
  const P1_EPS = [
    ['products', '/api/products'],
    ['tables/status', '/api/tables/status'],
    ['orders', '/api/orders'],
    ['categories', '/api/categories'],
    ['hybrid/status', '/api/hybrid/status'],
  ] as const
  phases.push(
    await runPhase('phase1-read-heavy', 60, 8, async (w, i) => {
      const [name, path] = P1_EPS[(w + i) % P1_EPS.length]
      await doGet(`phase1:${name}`, path)
    }),
  )
  printPhase(phases[phases.length - 1])
  await new Promise((r) => setTimeout(r, 1500))

  // ── PHASE 2: write-path (order rush: create → immediate cancel) ─
  phases.push(await runPhase('phase2-write-path', 45, 6, async () => writeCycle('phase2', P)))
  printPhase(phases[phases.length - 1])
  await new Promise((r) => setTimeout(r, 1500))

  // ── PHASE 3: burst (Friday 8pm spike) ───────────────────────────
  phases.push(
    await runPhase('phase3-burst', 10, 24, async (w, i) => {
      const isProd = (w + i) % 2 === 0
      await doGet(
        `phase3:${isProd ? 'products' : 'tables/status'}`,
        isProd ? '/api/products' : '/api/tables/status',
      )
    }),
  )
  printPhase(phases[phases.length - 1])
  await new Promise((r) => setTimeout(r, 1500))

  // ── PHASE 4: reports under load ─────────────────────────────────
  const P4_EPS = [
    ['zreport', '/api/reports/zreport'],
    ['sales', '/api/reports/sales'],
    ['forecast', '/api/reports/forecast'],
  ] as const
  phases.push(
    await runPhase('phase4-reports', 15, 4, async (w, i) => {
      const [name, path] = P4_EPS[(w + i) % P4_EPS.length]
      await doGet(`phase4:${name}`, path)
    }),
  )
  printPhase(phases[phases.length - 1])
  await new Promise((r) => setTimeout(r, 1500))

  // ── PHASE 5: KDS+POS mixed (realistic shift) ────────────────────
  phases.push(
    await runPhase('phase5-kds-pos-mix', 30, 10, async () => {
      const r = Math.random()
      if (r < 0.7) await doGet('phase5:orders', '/api/orders')
      else if (r < 0.9) await doGet('phase5:products', '/api/products')
      else await writeCycle('phase5', P)
    }),
  )
  printPhase(phases[phases.length - 1])

  const memoryAfter = capturePs()
  const devLogLinesSuiteEnd = devLogLines()
  const finishedAt = new Date().toISOString()

  const totalRequests = phases.reduce((a, p) => a + p.totalRequests, 0) + warmupResult.totalRequests
  const totalErrors = phases.reduce((a, p) => a + p.errors, 0) + warmupResult.errors

  const results = {
    suite: 'r31-stress (Task 2-b)',
    base: BASE,
    writeProduct: P,
    writeProductNote: note,
    startedAt,
    finishedAt,
    criticalAbort,
    totals: {
      totalRequests,
      totalErrors,
      headlineRequests: phases.reduce((a, p) => a + p.totalRequests, 0),
    },
    warmup: warmupResult,
    phases,
    createdOrderCount: createdOrders.length,
    createdOrders,
    memory: { before: memoryBefore, after: memoryAfter },
    devLog: { linesSuiteStart: devLogLinesSuiteStart, linesSuiteEnd: devLogLinesSuiteEnd },
    baseline,
  }
  writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2))
  writeFileSync(
    IDS_FILE,
    JSON.stringify({ createdCount: createdOrders.length, ids: createdOrders.map((o) => o.id) }, null, 2),
  )

  console.log('\n================ R31 STRESS SUITE SUMMARY ================')
  for (const p of [warmupResult, ...phases]) {
    const worst = Object.values(p.endpoints).reduce((m, e) => Math.max(m, e.p99ms), 0)
    console.log(
      `${p.name.padEnd(36)} n=${String(p.totalRequests).padStart(6)} rps=${String(p.reqPerSec).padStart(7)} errors=${String(p.errors).padStart(3)} worstP99=${worst}ms`,
    )
  }
  console.log(
    `TOTAL: ${totalRequests} requests (incl. warmup), ${totalErrors} errors, dev.log ${devLogLinesSuiteStart} → ${devLogLinesSuiteEnd} lines`,
  )
  console.log(
    `MEMORY next-server RSS: ${memoryBefore.nextServerRssKb} KB → ${memoryAfter.nextServerRssKb} KB (growth ${(memoryAfter.nextServerRssKb ?? 0) - (memoryBefore.nextServerRssKb ?? 0)} KB)`,
  )
  console.log(`\nCREATED TEST ORDER IDS (${createdOrders.length}):`)
  console.log(JSON.stringify(createdOrders.map((o) => o.id)))
  if (criticalAbort) {
    console.log('\n!!! CRITICAL: abort detected — dev server stopped answering. dev.log tail:')
    try {
      console.log(execSync(`tail -n 60 ${DEV_LOG}`, { encoding: 'utf8' }).slice(0, 8000))
    } catch {}
  }
  console.log(`\nresults → ${RESULTS_FILE}\nids     → ${IDS_FILE}\nbaseline→ ${BASELINE_FILE}`)
  await db.$disconnect()
}

main().catch((e) => {
  console.error('HARNESS FAILURE:', e)
  process.exit(1)
})
