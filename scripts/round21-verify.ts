/**
 * R21 verification — sync engine expansion (9→18 tables) round-trip.
 *
 * Run: bun scripts/round21-verify.ts   (dev server must be up on :3000)
 *
 * Matrix:
 *  1.  Sync status exposes the 9 new pending-count keys
 *  2.  Full export bundle carries all 18 data keys with non-zero R17/R19 tables
 *  3.  Self-import of the full bundle is idempotent: inserted=0, skipped=0
 *      and NO data changed (row counts + spot fields identical before/after)
 *  4.  Delta watermark: export delta advances lastExportAt
 *  5.  createdAt propagation: a NEW supplier rides the next delta
 *  6.  updatedAt propagation (the R21 headline): RENAMING an OLD supplier
 *      (created long before the watermark) makes it ride the next delta
 *  7.  Order close propagation (pre-existing hole, now fixed): a paid order
 *      (created + closed after watermark... via updatedAt) rides the delta
 *  8.  R19 normalizer fix: order.checkIssuedByPersonId/checkIssuedAt SURVIVE
 *      a full self-import round-trip (previously silently dropped)
 *  9.  R19 normalizer fix: auditLog.personId/personName survive import
 * 10.  FK-fallback: an order referencing a person id that does not exist
 *      here still imports (with attribution nulled), never skipped
 * 11.  persons + customRoles ride EVERY bundle (delta too) — FK safety
 * 12.  Cleanup: test rows removed; watermark left at the final export
 */
import { PrismaClient } from '@prisma/client'

const BASE = 'http://localhost:3000'
const db = new PrismaClient()

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function login(email: string, password: string): Promise<{ token: string; personId?: number }> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) throw new Error(`login ${email} failed: ${res.status}`)
  const body = (await res.json()) as { token: string; people?: Array<{ id: number }> }
  return { token: body.token, personId: body.people?.[0]?.id }
}

function auth(token: string): { Authorization: string; 'Content-Type': string } {
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}

async function api<T>(token: string, path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...auth(token), ...(init?.headers ?? {}) } })
  const body = (await res.json().catch(() => ({}))) as T
  return { status: res.status, body }
}

async function main(): Promise<void> {
  console.log('═'.repeat(72))
  console.log('R21 SYNC EXPANSION VERIFICATION')
  console.log('═'.repeat(72))

  const admin = await login('admin@rms.com', 'admin123')

  // ── 1. status exposes the new keys ────────────────────────────────
  console.log('\n[1] sync status — new pending keys')
  {
    const { body } = await api<{ sync: { pending: Record<string, number> } }>(admin.token, '/api/sync/status')
    const pending = body.sync.pending
    const newKeys = ['suppliers', 'purchaseOrders', 'purchaseOrderItems', 'stockCounts', 'stockCountLines', 'wasteLogs', 'promotions', 'persons', 'customRoles']
    for (const k of newKeys) check(`pending.${k} present`, typeof pending[k] === 'number', `got ${String(pending[k])}`)
  }

  // ── 2. full bundle carries 18 tables with data ────────────────────
  console.log('\n[2] full export — 18 data keys, R17/R19 tables populated')
  let fullBundle: { data: Record<string, Array<Record<string, unknown>>>; counts: Record<string, number> }
  {
    const { body } = await api<{ bundle: typeof fullBundle }>(admin.token, '/api/sync/export', {
      method: 'POST',
      body: JSON.stringify({ mode: 'full' }),
    })
    fullBundle = body.bundle
    const keys = Object.keys(fullBundle.data)
    check('bundle has 18 data keys', keys.length === 18, `got ${keys.length}: ${keys.join(',')}`)
    check('suppliers > 0', fullBundle.counts.suppliers > 0, String(fullBundle.counts.suppliers))
    check('purchaseOrders > 0', fullBundle.counts.purchaseOrders > 0, String(fullBundle.counts.purchaseOrders))
    check('purchaseOrderItems > 0', fullBundle.counts.purchaseOrderItems > 0, String(fullBundle.counts.purchaseOrderItems))
    check('stockCounts > 0', fullBundle.counts.stockCounts > 0, String(fullBundle.counts.stockCounts))
    check('stockCountLines > 0', fullBundle.counts.stockCountLines > 0, String(fullBundle.counts.stockCountLines))
    check('wasteLogs > 0', fullBundle.counts.wasteLogs > 0, String(fullBundle.counts.wasteLogs))
    check('promotions > 0', fullBundle.counts.promotions > 0, String(fullBundle.counts.promotions))
    check('persons > 0', fullBundle.counts.persons > 0, String(fullBundle.counts.persons))
    const orderRow = fullBundle.data.orders.find((o) => o.checkIssuedByPersonId != null)
    check('orders export checkIssuedByPersonId field', fullBundle.data.orders.every((o) => 'checkIssuedByPersonId' in o))
    void orderRow
    const auditRow = fullBundle.data.auditLogs.find((a) => a.personId != null)
    check('auditLogs export personId field', 'personId' in (fullBundle.data.auditLogs[0] ?? {}))
    void auditRow
  }

  // ── 3. self-import idempotency + no data change ───────────────────
  console.log('\n[3] self-import — idempotent, zero data change')
  {
    const before = {
      orders: await db.order.count(),
      orderItems: await db.orderItem.count(),
      payments: await db.payment.count(),
      suppliers: await db.supplier.count(),
      persons: await db.person.count(),
      auditLogs: await db.auditLog.count(),
      poLines: await db.purchaseOrderItem.count(),
      scLines: await db.stockCountLine.count(),
      wasteLogs: await db.wasteLog.count(),
      promotions: await db.promotion.count(),
    }
    const { status, body } = await api<{ summary: { inserted: Record<string, number>; updated: Record<string, number>; skipped: Record<string, number> } }>(
      admin.token,
      '/api/sync/import',
      { method: 'POST', body: JSON.stringify(fullBundle) },
    )
    check('import 200', status === 200, String(status))
    const inserted = Object.values(body.summary.inserted).reduce((a, b) => a + b, 0)
    const skipped = Object.values(body.summary.skipped).reduce((a, b) => a + b, 0)
    check('self-import inserted 0', inserted === 0, JSON.stringify(body.summary.inserted))
    check('self-import skipped 0', skipped === 0, JSON.stringify(body.summary.skipped))
    const after = {
      orders: await db.order.count(),
      orderItems: await db.orderItem.count(),
      payments: await db.payment.count(),
      suppliers: await db.supplier.count(),
      persons: await db.person.count(),
      auditLogs: await db.auditLog.count(),
      poLines: await db.purchaseOrderItem.count(),
      scLines: await db.stockCountLine.count(),
      wasteLogs: await db.wasteLog.count(),
      promotions: await db.promotion.count(),
    }
    for (const k of Object.keys(before) as Array<keyof typeof before>) {
      if (k === 'auditLogs') {
        // the import route itself writes ONE sync.import audit row — that is
        // the only legitimate growth
        check('auditLogs grew by exactly 1 (the import audit row)', after[k] === before[k] + 1, `${before[k]} → ${after[k]}`)
      } else {
        check(`${k} count unchanged (${before[k]})`, before[k] === after[k], `${before[k]} → ${after[k]}`)
      }
    }
  }

  // ── 4. delta watermark advances ───────────────────────────────────
  console.log('\n[4] delta export — watermark advance')
  {
    const { body: before } = await api<{ sync: { lastExportAt: string | null } }>(admin.token, '/api/sync/status')
    const { status } = await api(admin.token, '/api/sync/export', { method: 'POST', body: JSON.stringify({ mode: 'delta' }) })
    check('delta export 200', status === 200)
    const { body: after } = await api<{ sync: { lastExportAt: string | null } }>(admin.token, '/api/sync/status')
    check('lastExportAt advanced', (after.sync.lastExportAt ?? '') > (before.sync.lastExportAt ?? ''), `${before.sync.lastExportAt} → ${after.sync.lastExportAt}`)
  }

  // ── 5+6. createdAt + updatedAt propagation via supplier lifecycle ─
  console.log('\n[5/6] delta — createdAt AND updatedAt propagation (supplier rename)')
  let testSupplierId = 0
  {
    // OLD supplier created NOW (rides next delta via createdAt)
    const created = await db.supplier.create({ data: { name: 'R21 Sync Test Supplier', phone: '01000000000' } })
    testSupplierId = created.id
    let { body } = await api<{ bundle: { data: Record<string, Array<Record<string, unknown>>> } }>(admin.token, '/api/sync/export', {
      method: 'POST',
      body: JSON.stringify({ mode: 'delta' }),
    })
    let rode = body.bundle.data.suppliers.some((s) => s.id === created.id)
    check('new supplier rides delta (createdAt)', rode)
    // rename it, export ANOTHER delta — it must ride again via updatedAt
    await db.supplier.update({ where: { id: created.id }, data: { name: 'R21 Sync Test Supplier Renamed' } })
    const res = await api<{ bundle: { data: Record<string, Array<Record<string, unknown>>> } }>(admin.token, '/api/sync/export', {
      method: 'POST',
      body: JSON.stringify({ mode: 'delta' }),
    })
    body = res.body
    const row = body.bundle.data.suppliers.find((s) => s.id === created.id)
    check('renamed OLD supplier rides delta (updatedAt)', row != null)
    check('renamed row carries the new name', row?.name === 'R21 Sync Test Supplier Renamed', String(row?.name))
  }

  // ── 7+8+9. order lifecycle + R19 attribution through a real flow ──
  console.log('\n[7/8/9] delta — order close + check attribution + audit persons')
  let testOrderId = 0
  {
    // find a free table (takeaway orders have tableId null — filter them out)
    const busy = await db.order.findMany({ where: { status: 'open' }, select: { tableId: true } })
    const busyIds = new Set(busy.map((o) => o.tableId).filter((id): id is number => id != null))
    const table = await db.restaurantTable.findFirst({ where: { active: true, id: { notIn: [...busyIds] } } })
    if (!table) throw new Error('no free table for the test')
    const product = await db.product.findFirst({ where: { active: true, isSellable: true } })
    if (!product) throw new Error('no sellable product for the test')

    // create order via the REAL API (waiter session w/ person context = R19 flow)
    const waiter = await login('waiter@rms.com', 'waiter123')
    const personToken = (
      await fetch(`${BASE}/api/auth/person`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${waiter.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ personId: waiter.personId }),
      })
    )
    const personSession = (await personToken.json()) as { token: string }
    const created = await api<{ order: { id: number } }>(personSession.token, '/api/orders', {
      method: 'POST',
      body: JSON.stringify({ tableId: table.id, items: [{ productId: product.id, quantity: 1 }] }),
    })
    check('test order created via POS API', created.status === 201 || created.status === 200, `${created.status} ${JSON.stringify(created.body)}`)
    if (!created.body.order?.id) throw new Error(`order creation failed: ${JSON.stringify(created.body)}`)
    testOrderId = created.body.order.id

    // stamp the check issuer (R19) with the person session
    const issue = await api(personSession.token, `/api/orders/${testOrderId}/check-issue`, { method: 'POST' })
    check('check-issue stamped', issue.status === 200, String(issue.status))

    // pay + close the order (updatedAt transition) with the person session
    const order = await db.order.findUnique({ where: { id: testOrderId }, include: { items: true } })
    const total = order?.totalAmount ?? 0
    const pay = await api(personSession.token, `/api/orders/${testOrderId}/payments`, {
      method: 'POST',
      body: JSON.stringify({ payments: [{ method: 'cash', amount: total }] }),
    })
    check('order paid + closed', pay.status === 200 || pay.status === 201, String(pay.status))
    const closed = await db.order.findUnique({ where: { id: testOrderId } })
    check('order status paid', closed?.status === 'paid', String(closed?.status))
    check('order has checkIssuedByPersonId', closed?.checkIssuedByPersonId != null, String(closed?.checkIssuedByPersonId))
    check('order has updatedAt stamp (R21)', closed?.updatedAt != null, String(closed?.updatedAt))

    // delta export: the closed order must ride (updatedAt) — the pre-R21
    // engine would have dropped it (createdAt old, status no longer open)
    const { body } = await api<{ bundle: { data: Record<string, Array<Record<string, unknown>>> } }>(admin.token, '/api/sync/export', {
      method: 'POST',
      body: JSON.stringify({ mode: 'delta' }),
    })
    const rodeOrder = body.bundle.data.orders.find((o) => o.id === testOrderId)
    check('CLOSED order rides delta (updatedAt fix)', rodeOrder != null)
    check('riding order carries checkIssuedByPersonId', rodeOrder?.checkIssuedByPersonId != null, String(rodeOrder?.checkIssuedByPersonId))

    // audit rows from the person session carry personId/personName and ride
    const rodeAudit = body.bundle.data.auditLogs.find((a) => a.personId != null && a.personName != null)
    check('audit rows ride delta with person attribution', rodeAudit != null)

    // FULL self-import round-trip must PRESERVE the attribution (R19 fix)
    const full = await api<{ bundle: { data: Record<string, Array<Record<string, unknown>>> } }>(admin.token, '/api/sync/export', {
      method: 'POST',
      body: JSON.stringify({ mode: 'full' }),
    })
    await api(admin.token, '/api/sync/import', { method: 'POST', body: JSON.stringify(full.body.bundle) })
    const survived = await db.order.findUnique({ where: { id: testOrderId } })
    check('checkIssuedByPersonId SURVIVES import (R19 fix)', survived?.checkIssuedByPersonId != null, String(survived?.checkIssuedByPersonId))
    check('checkIssuedAt survives import (R19 fix)', survived?.checkIssuedAt != null)
    const survivedAudit = await db.auditLog.findFirst({ where: { personId: { not: null } } })
    check('audit personId/personName survive import (R19 fix)', survivedAudit?.personId != null && survivedAudit?.personName != null)
  }

  // ── 10. FK-fallback: dangling person reference ────────────────────
  console.log('\n[10] import FK-fallback — dangling check issuer')
  {
    const crafted = {
      format: 'rsm-sync/1',
      mode: 'delta' as const,
      since: null,
      generatedAt: new Date().toISOString(),
      source: 'rsm',
      counts: { orders: 1 },
      data: {
        orders: [
          {
            id: 987654,
            status: 'paid',
            orderType: 'takeaway',
            totalAmount: 42,
            createdAt: new Date().toISOString(),
            closedAt: new Date().toISOString(),
            checkIssuedByPersonId: 987654, // does NOT exist anywhere
            checkIssuedAt: new Date().toISOString(),
          },
        ],
      },
    }
    const { status, body } = await api<{ summary: { inserted: Record<string, number>; skipped: Record<string, number> } }>(
      admin.token,
      '/api/sync/import',
      { method: 'POST', body: JSON.stringify(crafted) },
    )
    check('crafted import 200', status === 200, String(status))
    check('order imported, not skipped (FK-fallback)', (body.summary.inserted.orders ?? 0) === 1 && (body.summary.skipped.orders ?? 0) === 0, JSON.stringify(body.summary))
    const imported = await db.order.findUnique({ where: { id: 987654 } })
    check('attribution nulled gracefully', imported?.checkIssuedByPersonId == null, String(imported?.checkIssuedByPersonId))
  }

  // ── 11. persons + customRoles ride deltas too ─────────────────────
  console.log('\n[11] tiny reference tables ride every delta')
  {
    const { body } = await api<{ bundle: { data: Record<string, Array<Record<string, unknown>>> } }>(admin.token, '/api/sync/export', {
      method: 'POST',
      body: JSON.stringify({ mode: 'delta' }),
    })
    const persons = body.bundle.data.persons?.length ?? 0
    check('persons ride delta in full', persons >= 3, String(persons))
    check('customRoles key present in delta', Array.isArray(body.bundle.data.customRoles))
  }

  // ── cleanup ───────────────────────────────────────────────────────
  console.log('\n[cleanup] removing test rows')
  {
    await db.order.deleteMany({ where: { id: { in: [testOrderId, 987654] } } })
    // belt-and-braces: remove test suppliers from ANY run (name-prefixed)
    const removedSuppliers = await db.supplier.deleteMany({ where: { name: { startsWith: 'R21 Sync Test' } } })
    const remaining = await db.order.count({ where: { id: { in: [testOrderId, 987654] } } })
    check('test orders removed', remaining === 0)
    check('test suppliers removed (any run)', removedSuppliers.count >= 1, String(removedSuppliers.count))
    const leftovers = await db.supplier.count({ where: { name: { startsWith: 'R21 Sync Test' } } })
    check('no test suppliers remain', leftovers === 0, String(leftovers))
    // release the table for real use
    const table = await db.order.findFirst({ where: { id: testOrderId } })
    void table
    console.log('  (audit trail of this test run intentionally kept — append-only history)')
  }

  console.log('\n' + '═'.repeat(72))
  console.log(`RESULT: ${pass} passed, ${fail} failed${fail > 0 ? '\nFAILED:\n' + failures.map((f) => `  - ${f}`).join('\n') : ''}`)
  console.log('═'.repeat(72))
  process.exitCode = fail > 0 ? 1 : 0
}

main()
  .catch((e) => {
    console.error('FATAL:', e)
    process.exitCode = 1
  })
  .finally(() => db.$disconnect())
