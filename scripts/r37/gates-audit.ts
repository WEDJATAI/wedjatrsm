/**
 * R37 — Stress supplement: verifies the r37 hardening round + platform gates.
 *
 * Phases (all against the LIVE dev server on :3000):
 *   A  r37 gate fixes       custom role (dashboard/products perms) reaches the
 *                           4 dashboard APIs + modifier-group write gate; waiter
 *                           still denied; unauth still 401.
 *   B  CRON gate            no secret → 401; correct secret → 200 (idempotent jobs).
 *   C  Download gates       windows + macOS: unauth 401, wrong password 403,
 *                           correct password grants signed URL, tokenless GET
 *                           401, cross-platform token rejected.
 *   D  Rate-limit machinery 12 rapid wrong logins → 429 by attempt ≤ 11
 *                           (nonexistent identifier, burns nothing E2E needs).
 *   E  Robustness probes    404s, 400s, malformed JSON, SQLi-shaped inputs —
 *                           never a 500.
 *
 * Usage: NODE_ENV=production bun scripts/r37/gates-audit.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE = 'http://localhost:3000'
const OUT = join(process.cwd(), 'agent-ctx/r37-gates-results.json')
const DOWNLOAD_PASSWORD = process.env.RSM_DOWNLOAD_PASSWORD ?? '180787'
const CRON_SECRET = readFileSync(join(process.cwd(), '.env'), 'utf8')
  .split('\n')
  .find((l) => l.startsWith('CRON_SECRET='))
  ?.slice('CRON_SECRET='.length)
  ?.trim()

type Row = {
  phase: string
  probe: string
  expect: string
  status: number
  ms: number
  pass: boolean
  note?: string
}
const rows: Row[] = []

function tok(file: string): string {
  return readFileSync(file, 'utf8').trim()
}
const ADMIN = tok('/tmp/rsm-tok-manager-login.txt')
const WAITER = tok('/tmp/rsm-tok-waiter.txt')
const CUSTOM = tok('/tmp/rsm-tok-custom-meena.txt')

type Actor = 'unauth' | 'admin' | 'waiter' | 'custom'
const TOKENS: Record<Actor, string | null> = {
  unauth: null,
  admin: ADMIN,
  waiter: WAITER,
  custom: CUSTOM,
}

async function call(
  method: string,
  path: string,
  actor: Actor,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
  redirect: 'follow' | 'manual' = 'follow',
): Promise<{ status: number; ms: number; json: any; text: string; location?: string }> {
  const token = TOKENS[actor]
  const headers: Record<string, string> = { ...extraHeaders }
  if (token) headers.Authorization = `Bearer ${token}`
  let payload: string | undefined
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = typeof body === 'string' ? body : JSON.stringify(body)
  }
  const t0 = performance.now()
  const res = await fetch(BASE + path, { method, headers, body: payload, redirect })
  const ms = Math.round(performance.now() - t0)
  const text = await res.text()
  let json: any = null
  try {
    json = JSON.parse(text)
  } catch {
    /* non-JSON body (binary download etc.) */
  }
  return { status: res.status, ms, json, text, location: res.headers.get('location') ?? undefined }
}

function record(
  phase: string,
  probe: string,
  expect: string,
  r: { status: number; ms: number },
  pass: boolean,
  note?: string,
) {
  rows.push({ phase, probe, expect, status: r.status, ms: r.ms, pass, note })
  console.log(`${pass ? '✅' : '❌'} [${phase}] ${probe} → ${r.status} (${r.ms}ms)${note ? ' — ' + note : ''}`)
}

async function phaseA() {
  console.log('\n── Phase A: r37 gate fixes ──')
  // Custom role "مدير الصاله" carries dashboard+products (+16 more) but is
  // neither admin nor developer. Before r37 the first/last two returned 403.
  let r = await call('GET', '/api/ai/briefing', 'custom')
  record('A', 'custom GET /ai/briefing', '200', r, r.status === 200, 'was 403 pre-r37 (dashboard perm)')

  r = await call('GET', '/api/reports/sales', 'custom')
  record('A', 'custom GET /reports/sales', '200', r, r.status === 200)

  r = await call('GET', '/api/reports/forecast', 'custom')
  record('A', 'custom GET /reports/forecast', '200', r, r.status === 200)

  r = await call('GET', '/api/inventory/low-stock', 'custom')
  record('A', 'custom GET /inventory/low-stock', '200', r, r.status === 200)

  // Modifier-group write: gate passes for products-perm custom (junk body →
  // 400 validation, NOT 403 gate).
  r = await call('POST', '/api/modifier-groups', 'custom', { name: '' })
  record('A', 'custom POST /modifier-groups (junk)', '400 (gate passed)', r, r.status === 400, 'was 403 pre-r37 (products perm)')

  r = await call('POST', '/api/modifier-groups', 'waiter', { name: 'x' })
  record('A', 'waiter POST /modifier-groups', '403', r, r.status === 403, 'waiter lacks products perm')

  r = await call('POST', '/api/modifier-groups', 'unauth', { name: 'x' })
  record('A', 'unauth POST /modifier-groups', '401', r, r.status === 401)

  r = await call('GET', '/api/ai/briefing', 'waiter')
  record('A', 'waiter GET /ai/briefing', '403', r, r.status === 403)
}

async function phaseB() {
  console.log('\n── Phase B: CRON gate ──')
  let r = await call('POST', '/api/cron/daily-digest', 'unauth')
  record('B', 'digest no secret', '401', r, r.status === 401)

  r = await call('POST', '/api/cron/turso-sync', 'unauth')
  record('B', 'turso-sync no secret', '401', r, r.status === 401)

  if (!CRON_SECRET) {
    record('B', 'CRON_SECRET available', 'present', { status: 0, ms: 0 }, false, 'missing from .env')
    return
  }
  r = await call('POST', '/api/cron/turso-sync', 'unauth', undefined, {
    Authorization: `Bearer ${CRON_SECRET}`,
  })
  record('B', 'turso-sync correct secret', '200', r, r.status === 200, 'idempotent replica refresh')

  r = await call('POST', '/api/cron/turso-sync', 'unauth', undefined, {
    Authorization: 'Bearer wrong-secret-value',
  })
  record('B', 'turso-sync wrong secret', '401', r, r.status === 401)

  r = await call('POST', `/api/cron/turso-sync?key=${CRON_SECRET}`, 'unauth')
  record('B', 'turso-sync ?key= query param', '200', r, r.status === 200, 'manual-trigger path')

  // daily-digest is idempotent by date — safe to fire once with the secret.
  r = await call('POST', '/api/cron/daily-digest', 'unauth', undefined, {
    Authorization: `Bearer ${CRON_SECRET}`,
  })
  record('B', 'digest correct secret', '200', r, r.status === 200, 'idempotent by date')
}

async function phaseC() {
  console.log('\n── Phase C: Download gates ──')
  const grants: Record<string, string | null> = { windows: null, macos: null }
  for (const platform of ['windows', 'macos'] as const) {
    let r = await call('POST', `/api/download/${platform}`, 'unauth', { password: DOWNLOAD_PASSWORD })
    record('C', `${platform} unauth POST`, '401', r, r.status === 401)

    r = await call('POST', `/api/download/${platform}`, 'admin', { password: '000000' })
    record('C', `${platform} wrong password`, '403', r, r.status === 403, '600ms penalty applies')

    r = await call('POST', `/api/download/${platform}`, 'admin', { password: DOWNLOAD_PASSWORD })
    const url: string | undefined = r.json?.url
    const token = url?.split('token=')?.[1]
    grants[platform] = token ? decodeURIComponent(token) : null
    const grantOk = r.status === 200 && !!url && !!token
    record('C', `${platform} correct password`, '200 + signed URL', r, grantOk, 'grant issued (full artifact download verified in r34-r36 E2E)')

    r = await call('GET', `/api/download/${platform}`, 'unauth')
    record('C', `${platform} GET without token`, '401', r, r.status === 401)

    if (token) {
      // Local artifact may or may not exist: 200 (stream) or 302 (GitHub
      // mirror) are both the designed success paths.
      const g = await fetch(`${BASE}/api/download/${platform}?token=${encodeURIComponent(token)}`, {
        redirect: 'manual',
      })
      record(
        'C',
        `${platform} GET with valid token`,
        '200 or 302→mirror',
        { status: g.status, ms: 0 },
        g.status === 200 || g.status === 302,
        g.status === 302 ? '→ GitHub mirror (dist not built locally)' : 'local stream',
      )
    }
  }
  // Cross-platform token purpose check (r33 design): a windows grant must NOT
  // redeem on the macos route and vice versa.
  if (grants.windows) {
    const r = await call('GET', `/api/download/macos?token=${encodeURIComponent(grants.windows)}`, 'unauth')
    record('C', 'windows token on macos route', '401', r, r.status === 401, 'purpose-scoped tokens')
  }
  if (grants.macos) {
    const r = await call('GET', `/api/download/windows?token=${encodeURIComponent(grants.macos)}`, 'unauth')
    record('C', 'macos token on windows route', '401', r, r.status === 401, 'purpose-scoped tokens')
  }
}

async function phaseD() {
  console.log('\n── Phase D: Rate-limit machinery ──')
  // Nonexistent identifier — burns nothing the browser E2E needs.
  let last = { status: 0, ms: 0 }
  let hit429 = -1
  for (let i = 1; i <= 12; i++) {
    const r = await call('POST', '/api/auth/login', 'unauth', {
      email: `nonexistent-${Date.now()}@example.com`,
      password: 'wrong',
    })
    last = r
    if (r.status === 429 && hit429 === -1) hit429 = i
    if (r.status !== 401 && r.status !== 429) {
      record('D', `login attempt #${i}`, '401|429', r, false, `unexpected ${r.status}`)
      return
    }
  }
  record(
    'D',
    '12 rapid wrong logins',
    '429 by attempt ≤ 11',
    last,
    hit429 !== -1 && hit429 <= 11,
    hit429 === -1 ? 'never throttled' : `throttled at attempt #${hit429}`,
  )
}

async function phaseE() {
  console.log('\n── Phase E: Robustness probes ──')
  let r = await call('GET', '/api/orders/999999999', 'admin')
  record('E', 'GET order 999999999', '404', r, r.status === 404)

  r = await call('POST', '/api/orders', 'admin', {})
  record('E', 'POST /orders empty body', '400', r, r.status === 400)

  r = await call('POST', '/api/orders', 'admin', '{not-json')
  record('E', 'POST /orders malformed JSON', '400', r, r.status === 400)

  r = await call('GET', "/api/orders?search=' OR 1=1--", 'admin')
  record('E', 'SQLi-shaped order search', '200 (sanitized)', r, r.status === 200)

  r = await call('GET', '/api/products?search=%3BDROP%20TABLE%20Product%3B--', 'admin')
  record('E', 'SQLi-shaped product search', '200 (sanitized)', r, r.status === 200)

  r = await call('GET', '/api/orders?status=notastatus', 'admin')
  record('E', 'invalid status filter', '200 (fallback)', r, r.status === 200 || r.status === 400)

  r = await call('POST', '/api/orders/999999999/payments', 'admin', {
    method: 'cash',
    amount: 50,
    payerName: 'probe',
  })
  record('E', 'pay nonexistent order', '404', r, r.status === 404)

  r = await call('GET', '/api/floorplans/999999999', 'admin')
  record('E', 'GET floorplan 999999999', '404', r, r.status === 404)
}

async function main() {
  const t0 = Date.now()
  await phaseA()
  await phaseB()
  await phaseC()
  await phaseD()
  await phaseE()

  const total = rows.length
  const passed = rows.filter((x) => x.pass).length
  const summary = {
    ranAt: new Date().toISOString(),
    wallSec: Math.round((Date.now() - t0) / 1000),
    total,
    passed,
    failed: total - passed,
    failures: rows.filter((x) => !x.pass),
  }
  writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 2))
  console.log(`\n══ r37 gates audit: ${passed}/${total} passed (${summary.wallSec}s) ══`)
  if (summary.failures.length) {
    console.log('FAILURES:')
    for (const f of summary.failures) console.log(`  ❌ [${f.phase}] ${f.probe} → ${f.status} (${f.note ?? ''})`)
  }
  console.log(`results → ${OUT}`)
}

void main()
