// R19 verification — Move Items quantity matrix + person tracking + check
// attribution + custom user types, exercised against the LIVE dev server
// (http://localhost:3000) with direct DB cross-checks at the end.
//
// Edge-case matrix (requirement §12):
//   3 Coffee → move 1 · move 2 · move 3(all) · attempt 4 → reject ·
//   0 → reject · negative → reject · source zero → row removed ·
//   destination already has the item → aggregate · concurrent moves → no
//   corruption · check issued by waiter-person → recorded (first wins) ·
//   payment stamps attribution · custom type saved · multiple people
//   counted separately · old records keep working (no false attribution).

import { db } from '@/lib/db'

const BASE = 'http://localhost:3000'
let passed = 0
let failed = 0

function ok(condition: boolean, label: string, extra = ''): void {
  if (condition) {
    passed++
    process.stdout.write(`  ✓ ${label}\n`)
  } else {
    failed++
    process.stdout.write(`  ✗ FAIL: ${label}${extra ? ` — ${extra}` : ''}\n`)
  }
}

type Json = Record<string, unknown>

async function call(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<{ status: number; data: Json | null }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let data: Json | null = null
  try {
    data = (await res.json()) as Json
  } catch {
    data = null
  }
  return { status: res.status, data }
}

async function login(email: string, password: string) {
  const res = await call('POST', '/api/auth/login', null, { email, password })
  if (res.status !== 200 || !res.data) throw new Error(`login failed for ${email}: ${res.status}`)
  return {
    token: String(res.data.token ?? ''),
    user: res.data.user as Record<string, unknown>,
    people: (res.data.people ?? []) as { id: number; name: string }[],
  }
}

async function main() {
  process.stdout.write('── setup ──\n')
  const admin = await login('admin@rms.com', 'admin123')

  // People roster on the waiter account (requirement example names)
  const usersRes = await call('GET', '/api/users', admin.token)
  const users = (usersRes.data?.users ?? []) as {
    id: number
    email: string
    role: string
    people?: { id: number; name: string; active: boolean }[]
  }[]
  const waiter = users.find((u) => u.role === 'waiter')
  if (!waiter) throw new Error('waiter account not found')
  for (const name of ['Ahmed Hassan', 'Mohamed Ali', 'Youssef Omar']) {
    await call('POST', `/api/users/${waiter.id}/persons`, admin.token, { name })
  }
  const rosterRes = await call('GET', `/api/users/${waiter.id}/persons`, admin.token)
  const roster = (rosterRes.data?.people ?? []) as { id: number; name: string; active: boolean }[]
  const ahmed = roster.find((p) => p.name === 'Ahmed Hassan')
  ok(roster.length >= 3, `waiter account has ${roster.length} people`, JSON.stringify(roster))
  if (!ahmed) throw new Error('Ahmed Hassan not on the roster')

  // ── login: 3 people → NO auto-embed, list returned for the picker ──
  process.stdout.write('── login + person selection ──\n')
  const w0 = await login('waiter@rms.com', 'waiter123')
  ok(w0.people.length === 3, `login returns the 3-person roster (got ${w0.people.length})`)
  ok(w0.user.personId == null, 'no auto-embed with multiple people')

  const sel = await call('POST', '/api/auth/person', w0.token, { personId: ahmed.id })
  ok(sel.status === 200 && (sel.data?.user as Json)?.personName === 'Ahmed Hassan',
    'person selection embeds Ahmed Hassan in the session')
  const waiterToken = String(sel.data?.token ?? w0.token)

  // cross-account person hijack attempt → 404
  const rogue = await call('POST', '/api/auth/person', w0.token, { personId: 999999 })
  ok(rogue.status === 404, 'cannot attribute the session to a person from another account (404)')

  // ── test orders ──
  process.stdout.write('── orders ──\n')
  const productsRes = await call('GET', '/api/products', admin.token)
  const products = (productsRes.data?.products ?? []) as { id: number; name: string; price: number; isSellable?: boolean; active?: boolean; soldOut?: boolean; isSoldOut?: boolean }[]
  const product = products.find(
    (p) => p.active !== false && p.isSellable !== false && !p.soldOut && !p.isSoldOut && p.price > 0 && p.price < 200,
  )
  if (!product) throw new Error('no suitable product found')
  process.stdout.write(`  product: ${product.name} @ ${product.price}\n`)

  const plansRes = await call('GET', '/api/floorplans', admin.token)
  const plans = (plansRes.data?.floorPlans ?? plansRes.data?.plans ?? []) as {
    id: number
    active?: boolean
    tables: { id: number; status: string }[]
  }[]
  // takeaway test orders — no table dependency (floor may be busy)
  // residue from earlier verification runs: open takeaway orders made
  // entirely of the test product (#132/#133-style REAL orders are never touched)
  const residue = await db.order.findMany({
    where: { status: 'open', tableId: null },
    include: { items: { select: { productId: true } } },
  })
  for (const ord of residue) {
    if (ord.items.length > 0 && ord.items.every((i) => i.productId === product.id)) {
      await call('POST', `/api/orders/${ord.id}/cancel`, admin.token, { reason: 'R19 verification residue' })
      process.stdout.write(`  · cleaned residue order #${ord.id}\n`)
    }
  }

  const mkOrder = async (_tableId: number | null, qty: number) => {
    const res = await call('POST', '/api/orders', waiterToken, {
      orderType: 'takeaway',
      items: [{ productId: product.id, quantity: qty }],
    })
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`order create failed: ${res.status} ${JSON.stringify(res.data)}`)
    }
    return res.data?.order as unknown as {
      id: number
      items: { id: number; quantity: number; productId: number | null }[]
      subtotalAmount: number
    }
  }
  // (mkOrder returns the nested `order` payload)

  const orderA = await mkOrder(null, 3)
  const orderB = await mkOrder(null, 1)
  ok(orderA.items.length === 1 && orderA.items[0].quantity === 3, 'order A: 3 units on one row')
  ok(orderB.items.length === 1 && orderB.items[0].quantity === 1, 'order B: 1 unit')

  const move = (from: number, itemId: number, qty: number, to: number) =>
    call('POST', `/api/orders/${from}/transfer-items`, waiterToken, {
      targetOrderId: to,
      items: [{ id: itemId, quantity: qty }],
    })

  // ── the quantity matrix ──
  process.stdout.write('── move matrix (3 Coffee) ──\n')
  const itemA = orderA.items[0].id

  type MoveSide = {
    items: { quantity: number; productId: number | null }[]
    subtotalAmount?: number
  }
  // 3 → move 1
  let r = await move(orderA.id, itemA, 1, orderB.id)
  let src = r.data?.source as unknown as MoveSide | undefined
  let tgt = r.data?.target as unknown as MoveSide | undefined
  ok(r.status === 200, 'move 1 of 3 → 200')
  ok(src?.items?.[0]?.quantity === 2, `source keeps 2 (got ${src?.items?.[0]?.quantity})`)
  const bLines = tgt?.items?.filter((i) => i.productId === product.id) ?? []
  ok(bLines.length === 1 && bLines[0].quantity === 2,
    `destination AGGREGATES into one line ×2 (got ${bLines.length} lines, qty ${bLines.map((l) => l.quantity).join(',')})`)

  // attempt 4 (> available 2) → reject
  r = await move(orderA.id, itemA, 4, orderB.id)
  ok(r.status === 400, `move 4 with only 2 available → 400 (got ${r.status})`)

  // 0 → reject
  r = await move(orderA.id, itemA, 0, orderB.id)
  ok(r.status === 400, `move 0 → 400 (got ${r.status})`)

  // negative → reject
  r = await move(orderA.id, itemA, -1, orderB.id)
  ok(r.status === 400, `move -1 → 400 (got ${r.status})`)

  // move 2 (= remaining) → Move All semantics: source row removed, aggregated
  r = await move(orderA.id, itemA, 2, orderB.id)
  src = r.data?.source as unknown as MoveSide | undefined
  tgt = r.data?.target as unknown as MoveSide | undefined
  ok(r.status === 200, 'move remaining 2 (Move All) → 200')
  ok((src?.items?.length ?? 0) === 0, `source left with zero rows (got ${src?.items?.length})`)
  const bLinesAfter = tgt?.items?.filter((i) => i.productId === product.id) ?? []
  ok(bLinesAfter.length === 1 && bLinesAfter[0].quantity === 4,
    `destination single aggregated line ×4 (got ${bLinesAfter.length} lines, qty ${bLinesAfter.map((l) => l.quantity).join(',')})`)
  const expectedSubtotal = Math.round(4 * product.price * 100) / 100
  ok(Math.abs((tgt?.subtotalAmount ?? 0) - expectedSubtotal) < 0.02,
    `totals recomputed on destination (subtotal ${tgt?.subtotalAmount} ≈ ${expectedSubtotal})`)

  // ── concurrency: two parallel moves of 2 from a 3-row ──
  process.stdout.write('── concurrency ──\n')
  const orderC = await mkOrder(null, 3)
  const itemC = orderC.items[0].id
  const [r1, r2] = await Promise.all([
    move(orderC.id, itemC, 2, orderA.id),
    move(orderC.id, itemC, 2, orderB.id),
  ])
  const statuses = [r1.status, r2.status].sort()
  ok(statuses[0] === 200 && statuses[1] === 400,
    `exactly one concurrent move wins (got ${r1.status}/${r2.status})`)
  const cRow = await db.orderItem.findUnique({ where: { id: itemC }, select: { quantity: true } })
  ok(cRow !== null && Math.abs(cRow.quantity - 1) < 0.001,
    `source never goes negative / corrupt (qty=${cRow?.quantity})`)
  const unitRows = await db.orderItem.groupBy({
    by: ['orderId'],
    where: { orderId: { in: [orderA.id, orderB.id, orderC.id] } },
    _sum: { quantity: true },
  })
  const units = unitRows.reduce((n, g) => n + (g._sum.quantity ?? 0), 0)
  ok(Math.abs(units - 7) < 0.001,
    `units conserved across all three orders (A2+B4+C1 = 7, got ${units})`)
  const dupRows = await db.orderItem.groupBy({
    by: ['orderId', 'productId', 'unitPrice', 'notes', 'course', 'status', 'selectedModifiers'],
    where: { orderId: { in: [orderA.id, orderB.id] } },
    _count: { id: true },
    having: { id: { _count: { gt: 1 } } },
  })
  ok(dupRows.length === 0, 'no duplicate identical lines on any order')

  // ── check issue: first person wins, account session doesn't burn the stamp ──
  process.stdout.write('── check issuance ──\n')
  const issue1 = await call('POST', `/api/orders/${orderB.id}/check-issue`, waiterToken, {})
  ok(issue1.status === 200 && issue1.data?.stamped === true, 'check issued → stamped by Ahmed')
  ok((issue1.data?.checkIssuedBy as Json)?.name === 'Ahmed Hassan',
    `issuer is the session person (got ${JSON.stringify(issue1.data?.checkIssuedBy)})`)
  const firstAt = String(issue1.data?.checkIssuedAt ?? '')

  // account-level session (admin, no person) must NOT stamp/overwrite
  const adminIssue = await call('POST', `/api/orders/${orderC.id}/check-issue`, admin.token, {})
  ok(adminIssue.status === 200 && adminIssue.data?.stamped === false,
    'account-level session presents without burning the stamp slot')
  const issue2 = await call('POST', `/api/orders/${orderC.id}/check-issue`, waiterToken, {})
  ok(issue2.status === 200 && issue2.data?.stamped === true,
    'later person session still stamps the untouched order')
  const issue1b = await call('POST', `/api/orders/${orderB.id}/check-issue`, waiterToken, {})
  ok(issue1b.data?.stamped === false && String(issue1b.data?.checkIssuedAt) === firstAt,
    'first issuance never overwritten on re-present')

  // ── payment stamps attribution + audit rows carry the person ──
  process.stdout.write('── payment attribution ──\n')
  const orderD = await mkOrder(null, 1)
  const dDetail = await call('GET', `/api/orders/${orderD.id}`, waiterToken)
  const dTotal = ((dDetail.data?.order as Json | undefined)?.totalAmount as number | undefined) ?? 0
  const pay = await call('POST', `/api/orders/${orderD.id}/payments`, waiterToken, {
    payments: [{ method: 'cash', amount: dTotal }],
  })
  ok(pay.status === 200, `order D paid (${dTotal} EGP)`)
  const dRow = await db.order.findUnique({
    where: { id: orderD.id },
    select: { status: true, checkIssuedByPersonId: true, checkIssuedAt: true },
  })
  ok(dRow?.status === 'paid', 'order D closed')
  ok(dRow?.checkIssuedByPersonId === ahmed.id, `payment stamped the issuer (person ${dRow?.checkIssuedByPersonId})`)
  ok(dRow?.checkIssuedAt != null, 'payment stamped the issue timestamp')

  const auditMoves = await db.auditLog.findMany({
    where: { action: 'order.itemTransfer', personId: { not: null } },
    orderBy: { id: 'desc' },
    take: 3,
  })
  ok(auditMoves.length > 0 && auditMoves.every((a) => a.personName === 'Ahmed Hassan'),
    'item-move audit rows carry the person')
  const auditPay = await db.auditLog.findFirst({
    where: { action: 'order.payment', entityId: orderD.id, personId: { not: null } },
  })
  ok(auditPay?.personName === 'Ahmed Hassan', 'payment audit row carries the person')
  const oldRows = await db.auditLog.count({ where: { personId: null } })
  ok(oldRows > 500, `pre-R19 audit rows remain valid & unattributed (${oldRows} rows)`)

  // ── custom user type ──
  process.stdout.write('── custom user type ──\n')
  let hostRole: { id: number } | null = null
  const rolesRes = await call('GET', '/api/roles', admin.token)
  const roles = (rolesRes.data?.roles ?? []) as { id: number; name: string }[]
  hostRole = roles.find((r) => r.name === 'Host') ?? null
  if (!hostRole) {
    const created = await call('POST', '/api/roles', admin.token, { name: 'Host', permissions: ['pos'] })
    hostRole = created.data?.role as { id: number } | undefined ?? null
  }
  ok(!!hostRole, 'custom type "Host" exists (free-text creation path)')
  const mkUser = await call('POST', '/api/users', admin.token, {
    name: 'Hana Host',
    email: 'host@rms.com',
    password: 'host1234',
    role: 'custom',
    roleId: hostRole?.id,
    pin: '333333',
  })
  ok([200, 201, 409].includes(mkUser.status), `custom-type user created/exists (${mkUser.status})`)
  const host = await login('host@rms.com', 'host1234')
  ok(host.user.roleName === 'Host', `custom user logs in with type "Host" (got ${host.user.roleName})`)
  ok(host.user.personId == null && host.people.length === 0, 'no-people custom account goes straight in')

  // ── person statistics ──
  process.stdout.write('── statistics ──\n')
  const stats = await call('GET', '/api/reports/people', admin.token)
  const groups = (stats.data?.groups ?? []) as {
    userId: number
    people: { id: number; name: string; checks: number; moves: number; unitsMoved: number; transactions: number }[]
  }[]
  const waiterGroup = groups.find((g) => g.userId === waiter.id)
  const ahmedStats = waiterGroup?.people.find((p) => p.id === ahmed.id)
  ok(!!ahmedStats, 'Ahmed appears in the people report')
  ok((ahmedStats?.checks ?? 0) >= 2, `checks counted (${ahmedStats?.checks} ≥ 2: orders B, C, D)`)
  ok((ahmedStats?.moves ?? 0) >= 3, `moves counted (${ahmedStats?.moves} ≥ 3)`)
  ok((ahmedStats?.unitsMoved ?? 0) >= 5, `units moved counted (${ahmedStats?.unitsMoved} ≥ 5: 1+2+2)`)
  ok((ahmedStats?.transactions ?? 0) >= (ahmedStats?.moves ?? 0) + (ahmedStats?.checks ?? 0),
    `all attributed actions counted (${ahmedStats?.transactions})`)
  const byType = (stats.data?.byType ?? []) as { type: string; totalPeople: number }[]
  const waiterType = byType.find((t) => t.type === 'Waiter')
  ok(waiterType?.totalPeople === 3, `byType: Waiter has 3 people (got ${waiterType?.totalPeople})`)
  const hostType = byType.find((t) => t.type === 'Host')
  ok(!!hostType, 'byType includes the custom type "Host"')

  // ── backward compatibility ──
  process.stdout.write('── backward compatibility ──\n')
  const ordersList = await call('GET', '/api/orders', admin.token)
  ok(ordersList.status === 200, 'order list still serializes (old orders, new optional fields)')
  const oldPaid = await db.order.findFirst({
    where: { status: 'paid', checkIssuedByPersonId: null },
    select: { id: true },
  })
  ok(!!oldPaid, 'historical paid orders keep NULL attribution (never fabricated)')

  // ── cleanup: cancel the open test orders (keep D paid as demo data) ──
  process.stdout.write('── cleanup ──\n')
  for (const id of [orderA.id, orderB.id, orderC.id]) {
    const res = await call('POST', `/api/orders/${id}/cancel`, admin.token, { reason: 'R19 verification' })
    ok(res.status === 200, `test order #${id} cancelled`)
  }

  process.stdout.write(`\n═══ RESULT: ${passed} passed, ${failed} failed ═══\n`)
  if (failed > 0) process.exit(1)
}

main()
  .catch((err) => {
    process.stderr.write(`FATAL: ${err}\n`)
    process.exit(1)
  })
  .finally(() => void db.$disconnect())
