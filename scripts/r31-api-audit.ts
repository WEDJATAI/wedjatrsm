/**
 * r31 API smoke + role-guard matrix audit (Task 2-a) — READ-MOSTLY.
 *
 *   bun scripts/r31-api-audit.ts
 *
 * Probes EVERY audited API route on the RUNNING dev server (localhost:3000)
 * with five actors (unauth / waiter(pos) / kitchen(kitchen) / custom Meena /
 * admin) and checks:
 *   1. availability      — no 500s
 *   2. auth enforcement  — 401 unauthenticated
 *   3. role authorization — 403 insufficient, 200 permitted
 *   4. input validation  — invalid bodies → 400/422, NEVER 500
 *   5. latency outliers  — >2s flagged
 *
 * SAFETY RULES baked in (mirrors the task brief):
 *   · tokens are read from /tmp and NEVER printed
 *   · mutations are only ever probed with (a) no auth, (b) a token that is
 *     expected to be REJECTED, or (c) admin + a deliberately INVALID body —
 *     validation fires before any write on all probed routes
 *   · /api/orders/{id}/cancel uses a PAID order owned by someone else
 *     (role guard 403 / status guard 400 — never a real cancel)
 *   · /api/orders/{id}/payments uses an OPEN order + {} body (validation 400
 *     fires before any payment row is written)
 *   · /api/tables/{id}/clear uses a FREE table + junk body → 400
 *   · POST /api/hybrid/sync-now is called ONCE with admin (allowed by brief)
 *   · POST /api/hybrid/pause is NEVER called with admin/custom — only
 *     unauth/waiter/kitchen (both must be rejected)
 *
 * Results → agent-ctx/r31-api-audit-results.json (+ console summary).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const BASE = 'http://localhost:3000'
const ROOT = process.cwd()
const OUT = join(ROOT, 'agent-ctx/r31-api-audit-results.json')

// ── tokens (never printed) ─────────────────────────────────────────────
function tok(file: string): string {
  return readFileSync(file, 'utf8').trim()
}
const TOKENS: Record<string, string | null> = {
  unauth: null,
  waiter: tok('/tmp/rsm-tok-waiter.txt'),
  kitchen: tok('/tmp/rsm-tok-kitchen.txt'),
  custom: tok('/tmp/rsm-tok-custom-meena.txt'),
  admin: tok('/tmp/rsm-tok-manager-login.txt'),
  developer: tok('/tmp/rsm-tok-developer-login.txt'),
}

type Actor = 'unauth' | 'waiter' | 'kitchen' | 'custom' | 'admin'

export type Probe = {
  kind: 'GET' | 'MUT' | 'SPECIAL'
  method: string
  path: string
  actor: Actor | 'developer'
  status: number
  ms: number
  expected: string // human-readable expectation
  ok: boolean
  snippet: string // first ~140 chars of the body (tokens never appear here)
}

const results: Probe[] = []
let passCount = 0
let failCount = 0

function verdict(probe: Probe): boolean {
  return probe.status !== 500 && probe.ok
}

async function call(
  method: string,
  path: string,
  actor: Actor | 'developer',
  body?: unknown,
): Promise<{ status: number; ms: number; text: string; json: any | null }> {
  const headers: Record<string, string> = {}
  const t = TOKENS[actor]
  if (t) headers.Authorization = `Bearer ${t}`
  let payload: string | undefined
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const t0 = performance.now()
  let status = 0
  let text = ''
  let json: any | null = null
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(60_000),
      redirect: 'manual',
    })
    status = res.status
    text = await res.text()
    try { json = JSON.parse(text) } catch { /* non-JSON */ }
  } catch (e) {
    status = -1
    text = `NETWORK-ERROR: ${e instanceof Error ? e.message : String(e)}`
  }
  const ms = Math.round(performance.now() - t0)
  return { status, ms, text, json }
}

function record(
  kind: Probe['kind'],
  method: string,
  path: string,
  actor: Actor | 'developer',
  expected: string,
  check: (status: number) => boolean,
  body?: unknown,
): Promise<{ status: number; ms: number; json: any | null; text: string }> {
  return (async () => {
    const r = await call(method, path, actor, body)
    const p: Probe = {
      kind,
      method,
      path,
      actor,
      status: r.status,
      ms: r.ms,
      expected,
      ok: check(r.status),
      snippet: r.text.replace(/\s+/g, ' ').slice(0, 140),
    }
    if (verdict(p)) passCount++
    else failCount++
    results.push(p)
    const icon = verdict(p) ? '✓' : '✗'
    console.log(
      `  [${icon}] ${method} ${path} (${actor}) → ${r.status} ${r.ms}ms  exp: ${expected}` +
        (verdict(p) ? '' : `   GOT: ${p.snippet}`),
    )
    return r
  })()
}

const is = (...codes: number[]) => (s: number) => codes.includes(s)
const not500 = (s: number) => s !== 500 && s !== -1

// ══════════════════════════════════════════════════════════════════════
async function main() {
  console.log('══ r31 API AUDIT — GET role matrix ══')

  // ── Phase 0: context prefetch (admin) ────────────────────────────────
  console.log('\n── phase 0 · context prefetch')
  const me = await call('GET', '/api/auth/me', 'waiter')
  const waiterUserId = me.json?.user?.id ?? null
  console.log(`  waiter userId = ${waiterUserId}`)

  const paidRes = await call('GET', '/api/orders?status=paid', 'admin')
  const paidOrders: any[] = paidRes.json?.orders ?? []
  const paidOther = paidOrders.find((o) => o.userId !== waiterUserId) ?? paidOrders[0] ?? null
  console.log(
    `  paid orders visible: ${paidOrders.length}; cancel-probe target = #${paidOther?.id} (owner ${paidOther?.userId})`,
  )

  const openRes = await call('GET', '/api/orders?status=open', 'admin')
  const openOrders: any[] = openRes.json?.orders ?? []
  const openOrder = openOrders[0] ?? null
  console.log(`  open orders: ${openOrders.length}; payments-probe target = #${openOrder?.id}`)

  const tablesRes = await call('GET', '/api/tables/status', 'admin')
  const tables: any[] = tablesRes.json?.tables ?? tablesRes.json ?? []
  const freeTable = Array.isArray(tables) ? (tables.find((t) => t?.status === 'free') ?? tables[0]) : null
  console.log(`  free table for clear-probe = #${freeTable?.id} (${freeTable?.status})`)

  // sanity: developer is admin-equivalent on a classic-admin route
  await record(
    'SPECIAL', 'GET', '/api/ai/status', 'developer',
    '200 (developer = admin-equivalent, p11-d)',
    is(200),
  )

  // ── Phase 1: GET matrix ──────────────────────────────────────────────
  console.log('\n── phase 1 · GET matrix (expectations derived from source)')
  type Row = { path: string; exp: Record<Actor, number[] | 'public'> }
  const ANY = 'public' as const
  const o = (waiter: number[], kitchen: number[], custom: number[], admin: number[]) => ({
    unauth: [401], waiter, kitchen, custom, admin,
  })
  const GETS: Row[] = [
    { path: '/api/auth/me', exp: o([200], [200], [200], [200]) },
    { path: '/api/auth/team-wall', exp: o([200], [200], [200], [200]) }, // public by design
    { path: '/api/tables', exp: o([405], [405], [405], [405]) },        // POST-only route (no GET handler)
    { path: '/api/tables/status', exp: o([200], [200], [200], [200]) },
    { path: '/api/orders', exp: o([200], [200], [200], [200]) },
    { path: '/api/products', exp: o([200], [200], [200], [200]) },
    { path: '/api/categories', exp: o([200], [200], [200], [200]) },
    { path: '/api/modifier-groups', exp: o([200], [200], [200], [200]) },
    { path: '/api/customers', exp: o([200], [200], [200], [200]) },
    { path: '/api/customers/stats', exp: o([200], [200], [200], [200]) },
    { path: '/api/reservations', exp: o([200], [200], [200], [200]) },
    { path: '/api/promotions', exp: o([200, 403], [403], [200], [200]) }, // guard admin,promotions,pos
    { path: '/api/inventory', exp: o([200], [403], [200], [200]) },       // guard waiter,admin,inventory
    { path: '/api/inventory/low-stock', exp: o([200], [403], [200], [200]) },
    { path: '/api/inventory/transactions', exp: o([200], [403], [200], [200]) },
    { path: '/api/recipes', exp: o([403], [403], [200], [200]) },
    { path: '/api/suppliers', exp: o([403], [403], [403], [200]) },       // guard admin,purchases (custom lacks purchases)
    { path: '/api/purchase-orders', exp: o([403], [403], [403], [200]) },
    { path: '/api/stock-counts', exp: o([403], [403], [200], [200]) },
    { path: '/api/shifts', exp: o([200], [200], [200], [200]) },
    { path: '/api/users', exp: o([403], [403], [200], [200]) },
    { path: '/api/roles', exp: o([403], [403], [403], [200]) },          // custom lacks roles perm
    { path: '/api/audit', exp: o([403], [403], [403], [200]) },          // custom lacks audit perm
    { path: '/api/attendance', exp: o([403], [403], [200], [200]) },
    { path: '/api/attendance/me', exp: o([200], [200], [200], [200]) },
    { path: '/api/cash-drawer', exp: o([403], [403], [200], [200]) },
    { path: '/api/waste', exp: o([403], [403], [200], [200]) },
    { path: '/api/invoices', exp: o([403], [403], [200], [200]) },
    { path: '/api/floorplans', exp: o([200], [200], [200], [200]) },
    { path: '/api/integrations', exp: o([403], [403], [200], [200]) },
    { path: '/api/settings', exp: o([200], [200], [200], [200]) },
    { path: '/api/reports/sales', exp: o([403], [403], [200], [200]) },
    { path: '/api/reports/zreport', exp: o([403], [403], [200], [200]) },
    { path: '/api/reports/forecast', exp: o([403], [403], [200], [200]) },
    { path: '/api/reports/menu-engineering', exp: o([403], [403], [200], [200]) },
    { path: '/api/reports/payroll', exp: o([403], [403], [403], [200]) }, // custom lacks payroll perm
    { path: '/api/reports/people', exp: o([403], [403], [200], [200]) },
    { path: '/api/reports/my-shift', exp: o([200], [200], [200], [200]) },
    { path: '/api/reports/waste', exp: o([403], [403], [200], [200]) },
    { path: '/api/reports/inventory-value', exp: o([403], [403], [200], [200]) },
    { path: '/api/ai/status', exp: o([403], [403], [403], [200]) },      // classic admin-only list
    { path: '/api/vision/overview', exp: o([403], [403], [403], [200]) }, // vision perm (custom lacks)
    { path: '/api/vision/cameras', exp: o([403], [403], [403], [200]) },
    { path: '/api/vision/zones', exp: o([403], [403], [403], [200]) },
    { path: '/api/vision/movements', exp: o([200], [403], [200], [200]) }, // waiter,admin,pos,vision
    { path: '/api/vision/analytics', exp: o([403], [403], [403], [200]) },
    { path: '/api/vision/config', exp: o([403], [403], [403], [200]) },
    { path: '/api/hybrid/status', exp: o([401], [401], [200], [200]) },   // dual-auth: insuff. session ⇒ 401
    { path: '/api/sync/status', exp: o([403], [403], [200], [200]) },
    { path: '/api/desktop/package', exp: o([403], [403], [200], [200]) },
  ]
  for (const row of GETS) {
    for (const actor of ['unauth', 'waiter', 'kitchen', 'custom', 'admin'] as Actor[]) {
      const exp = row.exp[actor] === ANY ? [200] : (row.exp[actor] as number[])
      await record('GET', 'GET', row.path, actor, exp.join('|'), is(...exp))
    }
  }

  // ── Phase 2: mutation probes ─────────────────────────────────────────
  console.log('\n── phase 2 · mutation probes (safe: 401 / 403 / invalid-body 400)')

  // orders
  await record('MUT', 'POST', '/api/orders', 'unauth', '401', is(401))
  await record('MUT', 'POST', '/api/orders', 'kitchen', '403 (pos-only)', is(403))
  await record('MUT', 'POST', '/api/orders', 'admin', '400 (items required)', is(400), {})

  // order-items PUT — pos+kitchen route: waiter passes guard, {} → no-op 200; invalid qty → 400
  await record('MUT', 'PUT', '/api/order-items/1', 'unauth', '401', is(401))
  await record('MUT', 'PUT', '/api/order-items/1', 'waiter', '200 no-op or 400/404 (never 500)', not500, {})
  await record('MUT', 'PUT', '/api/order-items/1', 'admin', '400 (negative qty rejected)', is(400), { quantity: -5 })
  await record('MUT', 'PUT', '/api/order-items/1', 'admin', '400 (junk status rejected)', is(400), { status: 'yesterday' })

  // cancel — PAID order owned by another user: waiter/kitchen 403, admin 400 (paid guard)
  if (paidOther) {
    const cp = `/api/orders/${paidOther.id}/cancel`
    await record('MUT', 'POST', cp, 'unauth', '401', is(401))
    await record('MUT', 'POST', cp, 'waiter', '403 (not owner, not admin)', is(403), {})
    await record('MUT', 'POST', cp, 'kitchen', '403', is(403), {})
    await record('MUT', 'POST', cp, 'admin', '400 (cannot cancel paid order)', is(400), {})
  }

  // payments — OPEN order + {} (validation fires before any write)
  if (openOrder) {
    const pp = `/api/orders/${openOrder.id}/payments`
    await record('MUT', 'POST', pp, 'unauth', '401', is(401))
    await record('MUT', 'POST', pp, 'kitchen', '403', is(403), {})
    await record('MUT', 'POST', pp, 'waiter', '400 (payments must be non-empty array)', is(400), {})
    await record('MUT', 'POST', pp, 'admin', '400 (junk body)', is(400), { foo: 'bar' })
    await record('MUT', 'POST', pp, 'admin', '400 (negative amount)', is(400), { payments: [{ method: 'cash', amount: -10 }] })
    await record('MUT', 'POST', pp, 'admin', '400 (bad method)', is(400), { payments: [{ method: 'crypto', amount: 10 }] })
  } else {
    // fallback: paid order → status guard 400 (never reaches body)
    const pp = `/api/orders/${paidOther?.id ?? 1}/payments`
    await record('MUT', 'POST', pp, 'unauth', '401', is(401))
    await record('MUT', 'POST', pp, 'waiter', '400 (only open/deferred)', is(400), {})
    await record('MUT', 'POST', pp, 'admin', '400 (only open/deferred)', is(400), { foo: 'bar' })
  }

  // categories
  await record('MUT', 'POST', '/api/categories', 'unauth', '401', is(401))
  await record('MUT', 'POST', '/api/categories', 'waiter', '403', is(403), {})
  await record('MUT', 'POST', '/api/categories', 'kitchen', '403', is(403), {})
  await record('MUT', 'POST', '/api/categories', 'custom', '400 (name required; has categories perm)', is(400), {})
  await record('MUT', 'POST', '/api/categories', 'admin', '400 (name required)', is(400), {})
  await record('MUT', 'PUT', '/api/categories/1', 'waiter', '403', is(403), {})
  await record('MUT', 'PUT', '/api/categories/1', 'admin', '400 (name required)', is(400), {})
  await record('MUT', 'DELETE', '/api/categories/999999', 'unauth', '401', is(401))
  await record('MUT', 'DELETE', '/api/categories/999999', 'waiter', '403', is(403))
  await record('MUT', 'DELETE', '/api/categories/999999', 'admin', '404 (nonexistent, never 500)', is(404, 400, 409))

  // products
  await record('MUT', 'POST', '/api/products', 'waiter', '403', is(403), {})
  await record('MUT', 'POST', '/api/products', 'admin', '400 (validation)', is(400), {})
  await record('MUT', 'PUT', '/api/products/1', 'waiter', '403', is(403), {})
  await record('MUT', 'PUT', '/api/products/1', 'admin', '400 (validation)', is(400), {})
  await record('MUT', 'DELETE', '/api/products/999999', 'admin', '404/400 (nonexistent)', is(404, 400, 409))
  await record('MUT', 'DELETE', '/api/products/999999', 'waiter', '403', is(403))
  await record('MUT', 'PATCH', '/api/products/1/sold-out', 'admin', '400 (soldOut must be boolean)', is(400), {})
  await record('MUT', 'PATCH', '/api/products/1/sold-out', 'waiter', '400 (allowed role, bad body)', is(400), {})

  // users / roles
  await record('MUT', 'POST', '/api/users', 'waiter', '403', is(403), {})
  await record('MUT', 'POST', '/api/users', 'admin', '400 (validation)', is(400), {})
  await record('MUT', 'PUT', '/api/users/1', 'waiter', '403', is(403), {})
  await record('MUT', 'PUT', '/api/users/1', 'admin', '400/404 (invalid body)', is(400, 404, 422), {})
  await record('MUT', 'POST', '/api/roles', 'waiter', '403', is(403), {})
  await record('MUT', 'POST', '/api/roles', 'custom', '403 (custom lacks roles perm)', is(403), {})
  await record('MUT', 'POST', '/api/roles', 'admin', '400 (validation)', is(400), {})
  await record('MUT', 'PUT', '/api/roles/1', 'waiter', '403', is(403), {})
  await record('MUT', 'PUT', '/api/roles/1', 'admin', '400 (validation)', is(400), {})

  // suppliers / promotions / reservations
  await record('MUT', 'POST', '/api/suppliers', 'waiter', '403', is(403), {})
  await record('MUT', 'POST', '/api/suppliers', 'custom', '403 (custom lacks purchases)', is(403), {})
  await record('MUT', 'POST', '/api/suppliers', 'admin', '400 (validation)', is(400), {})
  await record('MUT', 'POST', '/api/promotions', 'waiter', '403', is(403), {})
  await record('MUT', 'POST', '/api/promotions', 'custom', '400 (has promotions; body invalid)', is(400), {})
  await record('MUT', 'POST', '/api/promotions', 'admin', '400 (validation)', is(400), {})
  await record('MUT', 'POST', '/api/reservations', 'kitchen', '403', is(403), {})
  await record('MUT', 'POST', '/api/reservations', 'waiter', '400 (has pos; body invalid)', is(400), {})
  await record('MUT', 'POST', '/api/reservations', 'admin', '400 (validation)', is(400), {})

  // attendance check-in — PUBLIC route (login-screen card): all actors → 400 on empty body
  await record('MUT', 'POST', '/api/attendance/check-in', 'unauth', '400 (username+pin required; public route)', is(400), {})
  await record('MUT', 'POST', '/api/attendance/check-in', 'waiter', '400 (validation)', is(400), {})
  await record('MUT', 'POST', '/api/attendance/check-in', 'admin', '400 (validation)', is(400), {})

  // cash drawer / waste / inventory adjust
  await record('MUT', 'POST', '/api/cash-drawer', 'waiter', '403', is(403), {})
  await record('MUT', 'POST', '/api/cash-drawer', 'custom', '400 (has cashdrawer; body invalid)', is(400), {})
  await record('MUT', 'POST', '/api/cash-drawer', 'admin', '400 (validation)', is(400), {})
  await record('MUT', 'POST', '/api/waste', 'waiter', '403', is(403), {})
  await record('MUT', 'POST', '/api/waste', 'admin', '400 (validation)', is(400), {})
  await record('MUT', 'POST', '/api/inventory/adjust', 'waiter', '403', is(403), {})
  await record('MUT', 'POST', '/api/inventory/adjust', 'custom', '400 (has inventory; body invalid)', is(400), {})
  await record('MUT', 'POST', '/api/inventory/adjust', 'admin', '400 (validation)', is(400), {})

  // vision simulate / ai
  await record('MUT', 'POST', '/api/vision/simulate', 'waiter', '403', is(403), {})
  await record('MUT', 'POST', '/api/vision/simulate', 'custom', '403 (custom lacks vision)', is(403), {})
  await record('MUT', 'POST', '/api/vision/simulate', 'admin', '400 (unknown scenario)', is(400), { foo: 'bar' })
  await record('MUT', 'POST', '/api/ai/copilot', 'waiter', '403', is(403), {})
  await record('MUT', 'POST', '/api/ai/copilot', 'custom', '403 (admin-only)', is(403), {})
  await record('MUT', 'POST', '/api/ai/copilot', 'admin', '400 (messages required)', is(400), {})
  await record('MUT', 'POST', '/api/ai/menu-search', 'unauth', '401', is(401))
  await record('MUT', 'POST', '/api/ai/menu-search', 'waiter', '400 (query required; any authed)', is(400), {})
  await record('MUT', 'POST', '/api/ai/menu-search', 'admin', '400 (query required)', is(400), {})

  // auth register — public, invalid body → 400
  await record('MUT', 'POST', '/api/auth/register', 'unauth', '400 (name/pin validation)', is(400), {})
  await record('MUT', 'POST', '/api/auth/register', 'unauth', '400 (junk body)', is(400), { foo: 'bar' })

  // settings PUT
  await record('MUT', 'PUT', '/api/settings', 'waiter', '403', is(403), {})
  await record('MUT', 'PUT', '/api/settings', 'custom', '200 no-op or 400 (has settings perm)', is(200, 400), {})
  await record('MUT', 'PUT', '/api/settings', 'admin', '200 no-op or 400 ({} = nothing to change)', is(200, 400), {})

  // tables / floorplans / modifier-groups / recipes / stock-counts
  await record('MUT', 'POST', '/api/tables', 'waiter', '403', is(403), {})
  await record('MUT', 'POST', '/api/tables', 'custom', '400 (has floorplans; floorPlanId required)', is(400), {})
  await record('MUT', 'POST', '/api/tables', 'admin', '400 (floorPlanId required)', is(400), {})
  await record('MUT', 'PUT', '/api/tables/1', 'waiter', '403', is(403), {})
  await record('MUT', 'PUT', '/api/tables/1', 'admin', '400 (validation)', is(400), {})
  if (freeTable) {
    const cl = `/api/tables/${freeTable.id}/clear`
    await record('MUT', 'POST', cl, 'unauth', '401', is(401))
    await record('MUT', 'POST', cl, 'waiter', '400 (free table cannot be cleared)', is(400), {})
    await record('MUT', 'POST', cl, 'admin', '400 (junk body on free table)', is(400), { foo: 'bar' })
  }
  await record('MUT', 'POST', '/api/floorplans', 'waiter', '403', is(403), {})
  await record('MUT', 'POST', '/api/floorplans', 'admin', '400 (name required)', is(400), {})
  await record('MUT', 'PUT', '/api/floorplans/1', 'waiter', '403', is(403), {})
  await record('MUT', 'PUT', '/api/floorplans/1', 'admin', '400 (validation)', is(400), {})
  await record('MUT', 'POST', '/api/modifier-groups', 'waiter', '403', is(403), {})
  await record('MUT', 'POST', '/api/modifier-groups', 'custom', '403 (classic admin-only)', is(403), {})
  await record('MUT', 'POST', '/api/modifier-groups', 'admin', '400 (validation)', is(400), {})
  await record('MUT', 'PUT', '/api/modifier-groups/1', 'waiter', '403', is(403), {})
  await record('MUT', 'PUT', '/api/modifier-groups/1', 'admin', '400 (validation)', is(400), {})
  await record('MUT', 'POST', '/api/recipes', 'waiter', '403', is(403), {})
  await record('MUT', 'POST', '/api/recipes', 'custom', '400 (has recipes; body invalid)', is(400), {})
  await record('MUT', 'POST', '/api/recipes', 'admin', '400 (validation)', is(400), {})
  await record('MUT', 'DELETE', '/api/recipes/999999', 'waiter', '403', is(403))
  await record('MUT', 'DELETE', '/api/recipes/999999', 'admin', '404 (nonexistent)', is(404, 400, 409))
  await record('MUT', 'POST', '/api/stock-counts', 'waiter', '403', is(403), {})
  await record('MUT', 'POST', '/api/stock-counts', 'admin', '400 (validation)', is(400), {})

  // hybrid — sync-now ONCE with admin; pause NEVER with admin/custom
  await record('MUT', 'POST', '/api/hybrid/sync-now', 'unauth', '401', is(401))
  await record('MUT', 'POST', '/api/hybrid/sync-now', 'waiter', '403', is(403))
  await record('MUT', 'POST', '/api/hybrid/sync-now', 'kitchen', '403', is(403))
  await record('MUT', 'POST', '/api/hybrid/sync-now', 'admin', '200 (one allowed live sync cycle)', is(200))
  await record('MUT', 'POST', '/api/hybrid/pause', 'unauth', '401', is(401))
  await record('MUT', 'POST', '/api/hybrid/pause', 'waiter', '403', is(403))
  await record('MUT', 'POST', '/api/hybrid/pause', 'kitchen', '403', is(403))
  // NB: hybrid/pause deliberately NOT probed with admin/custom (would halt sync)

  // ── Phase 3: special business-logic checks ──────────────────────────
  console.log('\n── phase 3 · special checks')

  // 3a. money math on 3 paid orders
  const money: any[] = []
  const sample = paidOrders.slice(0, 3)
  for (const ord of sample) {
    const full = await call('GET', `/api/orders?status=paid`, 'admin')
    // orders list already includes items+payments; recompute from the row
    const items: any[] = ord.items ?? []
    const payments: any[] = ord.payments ?? []
    const calcSub = Math.round(items.reduce((s, i) => s + i.quantity * i.unitPrice, 0) * 100) / 100
    const discount = ord.discountAmount ?? 0
    const base = Math.round((calcSub - discount) * 100) / 100
    const calcTax = Math.round(base * 0.14 * 100) / 100
    const calcSvc = Math.round(base * 0.12 * 100) / 100
    const calcTotal = Math.round((base + calcTax + calcSvc) * 100) / 100
    const paySum = Math.round(payments.reduce((s, p) => s + p.amount, 0) * 100) / 100
    money.push({
      id: ord.id,
      stored: {
        subtotal: ord.subtotalAmount, discount: ord.discountAmount,
        tax: ord.taxAmount, serviceTax: ord.serviceTaxAmount, total: ord.totalAmount,
        paidAmount: ord.paidAmount, remaining: ord.remainingAmount,
      },
      calc: { subtotal: calcSub, base, tax: calcTax, serviceTax: calcSvc, total: calcTotal, paymentsNet: paySum },
      items: items.map((i) => ({ productId: i.productId, qty: i.quantity, unitPrice: i.unitPrice })),
      payments: payments.map((p) => ({ method: p.method, amount: p.amount, tip: p.tip, ref: p.reference })),
      match:
        Math.abs(calcSub - ord.subtotalAmount) < 0.02 &&
        Math.abs(calcTax - ord.taxAmount) < 0.02 &&
        Math.abs(calcSvc - ord.serviceTaxAmount) < 0.02 &&
        Math.abs(calcTotal - ord.totalAmount) < 0.02 &&
        Math.abs(paySum - ord.totalAmount) < 0.02,
    })
  }
  for (const m of money) {
    console.log(
      `  order #${m.id} match=${m.match}  subtotal ${m.stored.subtotal} (calc ${m.calc.subtotal})  tax ${m.stored.tax} (calc ${m.calc.tax})  svc ${m.stored.serviceTax} (calc ${m.calc.serviceTax})  total ${m.stored.total} (calc ${m.calc.total})  payments ${m.calc.paymentsNet}`,
    )
  }

  // 3b. unauth enumeration on public auth routes
  const tw = await call('GET', '/api/auth/team-wall', 'unauth')
  const ml = await call('GET', '/api/auth/manager-login', 'unauth')
  const twText = JSON.stringify(tw.json ?? {})
  const mlText = JSON.stringify(ml.json ?? {})
  const leakCheck = {
    teamWall: {
      status: tw.status,
      keys: tw.json && typeof tw.json === 'object' ? Object.keys(tw.json) : [],
      leaksEmail: /@/.test(twText),
      leaksPin: /"pin"/i.test(twText),
      sample: twText.slice(0, 300),
    },
    managerLogin: {
      status: ml.status,
      keys: ml.json && typeof ml.json === 'object' ? Object.keys(ml.json) : [],
      leaksEmail: /@/.test(mlText),
      leaksPin: /"pin"/i.test(mlText),
      sample: mlText.slice(0, 300),
    },
  }
  console.log('  team-wall unauth:', leakCheck.teamWall.status, 'leaksEmail=', leakCheck.teamWall.leaksEmail, 'leaksPin=', leakCheck.teamWall.leaksPin)
  console.log('  manager-login unauth:', leakCheck.managerLogin.status, 'leaksEmail=', leakCheck.managerLogin.leaksEmail, 'leaksPin=', leakCheck.managerLogin.leaksPin)

  // 3c. settings response — check for a service-tax toggle
  const settingsJson = (await call('GET', '/api/settings', 'admin')).json
  console.log('  settings keys:', JSON.stringify(settingsJson?.settings ?? null))

  // 3d. SQL-injection shaped inputs (must NOT 500)
  const sqli: Array<[string, string]> = [
    ['GET', `/api/orders?status=${encodeURIComponent("'; DROP TABLE orders;--")}`],
    ['GET', `/api/orders?tableId=${encodeURIComponent("1 OR 1=1;--")}`],
    ['GET', `/api/customers?q=${encodeURIComponent("'; DROP TABLE customers;--")}`],
    ['GET', `/api/audit?entity=${encodeURIComponent("x' UNION SELECT 1,2,3--")}`],
  ]
  for (const [method, path] of sqli) {
    await record('SPECIAL', method, path, 'admin', '4xx or 2xx (never 500)', not500)
  }

  // ── summary ──────────────────────────────────────────────────────────
  const outliers = results.filter((r) => r.ms > 2000)
  const s500 = results.filter((r) => r.status === 500 || r.status === -1)
  console.log(`\n══ r31 AUDIT RESULT: ${passCount} pass · ${failCount} fail · ${results.length} probes`)
  console.log(`   500s/network errors: ${s500.length}${s500.length ? ' → ' + s500.map((r) => `${r.method} ${r.path}`).join(', ') : ''}`)
  console.log(`   latency >2s: ${outliers.length}${outliers.length ? ' → ' + outliers.map((r) => `${r.method} ${r.path} ${r.ms}ms (${r.actor})`).join(', ') : ''}`)

  const failed = results.filter((r) => !verdict(r))
  if (failed.length) {
    console.log('\n   FAILED probes:')
    for (const f of failed) {
      console.log(`   ✗ ${f.method} ${f.path} (${f.actor}) → ${f.status}  exp ${f.expected}  got: ${f.snippet}`)
    }
  }

  if (!existsSync(join(ROOT, 'agent-ctx'))) mkdirSync(join(ROOT, 'agent-ctx'), { recursive: true })
  writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    passCount, failCount, total: results.length,
    waiterUserId,
    cancelProbeOrderId: paidOther?.id ?? null,
    paymentsProbeOrderId: openOrder?.id ?? null,
    clearProbeTableId: freeTable?.id ?? null,
    money, leakCheck, settings: settingsJson?.settings ?? null,
    latencyOutliersMs: outliers.map((r) => ({ method: r.method, path: r.path, actor: r.actor, ms: r.ms })),
    serverErrors: s500,
    probes: results,
  }, null, 2))
  console.log(`\n   results → ${OUT}`)
}

main().catch((e) => { console.error('r31-api-audit crashed:', e); process.exit(1) })
