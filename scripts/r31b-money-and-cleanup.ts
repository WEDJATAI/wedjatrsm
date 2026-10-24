/**
 * r31b — follow-up checks for the r31 API audit (Task 2-a):
 *   1. cleanup: cancel stock count SC-0002 (id 2) — an open count sheet my
 *      junk-body probe created via POST /api/stock-counts {} → 201. Cancelling
 *      is the designed no-stock-change path; leaves the audit trail honest.
 *   2. money math on 3 PAID orders via the per-order GET (includes items +
 *      payments; the list endpoint omits them).
 *   3. targeted leak checks: /api/users pin visibility for custom vs admin;
 *      team-wall / manager-login unauth payload shapes.
 *   4. warm-cache latency of the heavy report endpoints.
 * Tokens are read from /tmp and never printed.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const BASE = 'http://localhost:3000'
const ROOT = process.cwd()
const OUT = join(ROOT, 'agent-ctx/r31b-money-results.json')

function tok(f: string): string { return readFileSync(f, 'utf8').trim() }
const T = {
  waiter: tok('/tmp/rsm-tok-waiter.txt'),
  kitchen: tok('/tmp/rsm-tok-kitchen.txt'),
  custom: tok('/tmp/rsm-tok-custom-meena.txt'),
  admin: tok('/tmp/rsm-tok-manager-login.txt'),
}

async function call(method: string, path: string, actor: keyof typeof T | 'unauth', body?: unknown) {
  const headers: Record<string, string> = {}
  if (actor !== 'unauth') headers.Authorization = `Bearer ${T[actor]}`
  let payload: string | undefined
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body) }
  const t0 = performance.now()
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(60_000) })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* */ }
  return { status: res.status, ms: Math.round(performance.now() - t0), json, text }
}

const round2 = (n: number) => Math.round(n * 100) / 100

async function main() {
  const out: any = { generatedAt: new Date().toISOString() }

  // ── 1. cleanup: cancel the probe-created stock count ─────────────────
  const cancel = await call('PATCH', '/api/stock-counts/2', 'admin', { action: 'cancel' })
  out.stockCountCleanup = { status: cancel.status, ms: cancel.ms, after: cancel.json?.stockCount?.status ?? null }
  console.log(`cleanup stock count #2 → ${cancel.status} status=${cancel.json?.stockCount?.status ?? '?'}`)

  // ── 2. money math on 3 paid orders ───────────────────────────────────
  const list = await call('GET', '/api/orders?status=paid', 'admin')
  const paid: any[] = list.json?.orders ?? []
  const sample = paid.slice(0, 3)
  const money: any[] = []
  for (const o of sample) {
    const r = await call('GET', `/api/orders/${o.id}`, 'admin')
    const ord = r.json?.order
    if (!ord) { money.push({ id: o.id, error: `detail GET ${r.status}` }); continue }
    const items: any[] = ord.items ?? []
    const payments: any[] = ord.payments ?? []
    const lines = items.map((i) => ({
      productId: i.productId, qty: i.quantity, unitPrice: i.unitPrice,
      lineTotal: round2(i.quantity * i.unitPrice),
    }))
    const calcSub = round2(lines.reduce((s, l) => s + l.lineTotal, 0))
    const discount = ord.discountAmount ?? 0
    const base = round2(calcSub - discount)
    const calcTax = round2(base * 0.14)
    const calcSvc = round2(base * 0.12)
    const calcTotal = round2(base + calcTax + calcSvc)
    const posPayments = payments.filter((p) => p.amount > 0)
    const refunds = payments.filter((p) => p.amount < 0)
    const grossPaid = round2(posPayments.reduce((s, p) => s + p.amount, 0))
    const netPaid = round2(payments.reduce((s, p) => s + p.amount, 0))
    const tips = round2(payments.reduce((s, p) => s + (p.tip ?? 0), 0))
    money.push({
      id: ord.id,
      status: ord.status,
      stored: {
        subtotal: ord.subtotalAmount, discount: ord.discountAmount, tax: ord.taxAmount,
        serviceTax: ord.serviceTaxAmount, total: ord.totalAmount,
        paidAmount: ord.paidAmount, remaining: ord.remainingAmount,
      },
      calc: { subtotal: calcSub, base, tax: calcTax, serviceTax: calcSvc, total: calcTotal },
      payments: { count: payments.length, grossPaid, refunds: refunds.length, netPaid, tips },
      checks: {
        subtotalMatch: Math.abs(calcSub - ord.subtotalAmount) < 0.02,
        taxMatch: Math.abs(calcTax - ord.taxAmount) < 0.02,
        serviceTaxMatch: Math.abs(calcSvc - ord.serviceTaxAmount) < 0.02,
        totalMatch: Math.abs(calcTotal - ord.totalAmount) < 0.02,
        paymentsMatchTotal: Math.abs(netPaid - ord.totalAmount) < 0.02,
      },
      lines,
      paymentRows: payments.map((p) => ({ method: p.method, amount: p.amount, tip: p.tip, ref: p.reference })),
    })
    const m = money[money.length - 1]
    console.log(
      `order #${ord.id}: subtotal ${ord.subtotalAmount} vs ${calcSub} · tax ${ord.taxAmount} vs ${calcTax} · svc ${ord.serviceTaxAmount} vs ${calcSvc} · total ${ord.totalAmount} vs ${calcTotal} · netPaid ${netPaid} (paid ${ord.paidAmount}) → ${JSON.stringify(m.checks)}`,
    )
  }
  out.money = money

  // ── 3. targeted leak checks ──────────────────────────────────────────
  const usersCustom = await call('GET', '/api/users', 'custom')
  const usersAdmin = await call('GET', '/api/users', 'admin')
  const cu: any[] = usersCustom.json?.users ?? []
  const au: any[] = usersAdmin.json?.users ?? []
  out.pinVisibility = {
    customStatus: usersCustom.status,
    customPinNonNull: cu.filter((u) => u.pin != null).length,
    customUserCount: cu.length,
    adminPinNonNull: au.filter((u) => u.pin != null).length,
    adminUserCount: au.length,
    customShowsEmail: cu.some((u) => typeof u.email === 'string' && u.email.includes('@')),
  }
  console.log(`pin visibility: custom sees ${out.pinVisibility.customPinNonNull}/${cu.length} pins, admin sees ${out.pinVisibility.adminPinNonNull}/${au.length}; custom sees emails: ${out.pinVisibility.customShowsEmail}`)

  // ── 4. warm-cache latency of heavy endpoints ─────────────────────────
  const heavy: Record<string, { status: number; ms: number }> = {}
  for (const p of ['/api/audit', '/api/reports/zreport', '/api/reports/payroll', '/api/reports/sales', '/api/reports/menu-engineering']) {
    const r = await call('GET', p, 'admin')
    heavy[p] = { status: r.status, ms: r.ms }
    console.log(`warm ${p} → ${r.status} ${r.ms}ms`)
  }
  out.heavyLatency = heavy

  writeFileSync(OUT, JSON.stringify(out, null, 2))
  console.log(`\n→ ${OUT}`)
}

main().catch((e) => { console.error('r31b crashed:', e); process.exit(1) })
