/**
 * R14 Layer-1 concurrency benchmark — direct Prisma against a DB copy.
 *
 * Simulates the production shape: ONE server process (one PrismaClient)
 * handling many concurrent terminal requests (KDS polls, POS catalog fetches,
 * floor-state reads, full order lifecycles, vision ingest events).
 *
 * Usage:
 *   bun scripts/load-test.ts <duration_seconds> <workers> <label> [dbPath]
 *   bun scripts/load-test.ts --cleanup [dbPath]     // remove loadtest data
 *
 * All writes are marked (externalRef / eventId prefix `loadtest-`) so the
 * harness can clean up after itself without touching real data.
 */
import { PrismaClient, Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
const dbPath =
  args.find((a) => !a.startsWith('--') && !/^\d+$/.test(a) && a !== args[0]?.split('=')[0] && a.includes('.db')) ||
  '/home/z/my-project/db/loadtest.db'

const db = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } })

type OpName = 'kds_poll' | 'pos_catalog' | 'floor_state' | 'order_cycle' | 'vision_ingest'
type Sample = { op: OpName; ms: number; ok: boolean; err?: string }

const ORDER_INCLUDE = {
  items: {
    include: {
      product: {
        select: {
          id: true,
          name: true,
          nameAr: true,
          allergens: true,
          category: { select: { prepDestination: true } },
        },
      },
    },
  },
  payments: true,
  table: { select: { id: true, name: true } },
  user: { select: { id: true, name: true } },
  customer: { select: { id: true, name: true, phone: true, points: true } },
} satisfies Prisma.OrderInclude

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[idx]
}

function classifyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (msg.includes('database is locked') || msg.includes('P2034') || msg.includes('SQLITE_BUSY')) return 'SQLITE_BUSY'
  if (msg.includes('P2024')) return 'POOL_TIMEOUT'
  if (msg.includes('Unique constraint')) return 'UNIQUE'
  return msg.slice(0, 200)
}

// ── op implementations (mirror the real API query shapes) ──────────
async function opKdsPoll(): Promise<void> {
  await db.order.findMany({
    where: { status: { in: ['open', 'sent', 'served'] } },
    include: ORDER_INCLUDE,
    orderBy: { createdAt: 'asc' },
  })
}

async function opPosCatalog(): Promise<void> {
  const products = await db.product.findMany({
    where: { active: true, isSellable: true },
    include: {
      category: { select: { id: true, name: true, nameAr: true, prepDestination: true } },
      modifierGroups: {
        where: { modifierGroup: { active: true } },
        orderBy: [{ sortOrder: 'asc' }, { modifierGroupId: 'asc' }],
        include: {
          modifierGroup: {
            include: {
              modifiers: { where: { active: true }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }] },
            },
          },
        },
      },
    },
    orderBy: { name: 'asc' },
  })
  void products.length
}

async function opFloorState(): Promise<void> {
  const floors = await db.floorPlan.findMany({
    where: { active: true },
    orderBy: { id: 'asc' },
    include: { tables: { where: { active: true }, orderBy: { name: 'asc' } } },
  })
  // serialize step (like the real API): count occupied tables per floor
  for (const f of floors) {
    void f.tables.length
  }
}

/** Full POS lifecycle: takeaway order → 2 items (one with modifiers/notes) → send → serve → pay → close. */
async function opOrderCycle(): Promise<void> {
  const products = await db.product.findMany({
    where: { active: true, isSellable: true },
    select: { id: true, price: true },
    take: 20,
  })
  if (products.length < 2) throw new Error('not enough products')
  const a = products[Math.floor(Math.random() * products.length)]
  let b = products[Math.floor(Math.random() * products.length)]
  if (b.id === a.id) b = products[(products.indexOf(b) + 1) % products.length]

  const subtotal = a.price + b.price * 2
  const discount = 0
  const net = subtotal - discount
  const tax = Math.round(net * 0.14 * 100) / 100
  const service = Math.round(net * 0.12 * 100) / 100

  const order = await db.order.create({
    data: {
      orderType: 'takeaway',
      status: 'open',
      userId: 1,
      guests: 1,
      externalRef: `loadtest-${randomUUID()}`,
      subtotalAmount: subtotal,
      discountAmount: discount,
      taxAmount: tax,
      serviceTaxAmount: service,
      totalAmount: Math.round((net + tax + service) * 100) / 100,
      items: {
        create: [
          { productId: a.id, quantity: 1, unitPrice: a.price, course: 'main', status: 'new' },
          {
            productId: b.id,
            quantity: 2,
            unitPrice: b.price,
            course: 'drink',
            status: 'new',
            notes: 'loadtest note',
            selectedModifiers: JSON.stringify([{ id: 1, name: 'Extra Sugar', nameAr: null, priceDelta: 0 }]),
          },
        ],
      },
    },
  })
  // send → preparing → ready → served (item status transitions like the KDS)
  await db.orderItem.updateMany({ where: { orderId: order.id }, data: { status: 'preparing' } })
  await db.orderItem.updateMany({ where: { orderId: order.id }, data: { status: 'served' } })
  // payment + close
  await db.payment.create({
    data: { orderId: order.id, method: 'cash', amount: order.totalAmount, tip: 0 },
  })
  await db.order.update({ where: { id: order.id }, data: { status: 'paid', closedAt: new Date() } })
}

/** Vision-edge style ingest: table-state read → update → event insert. */
async function opVisionIngest(): Promise<void> {
  const zone = await db.visionZone.findFirst({ select: { id: true, tableId: true } })
  if (!zone?.tableId) return
  const people = Math.floor(Math.random() * 5)
  await db.visionTableState.update({
    where: { tableId: zone.tableId },
    data: { peopleCount: people, state: people > 0 ? 'occupied' : 'empty', lastEventAt: new Date() },
  })
  await db.visionEvent.create({
    data: {
      eventId: `loadtest-${randomUUID()}`,
      type: 'OCCUPANCY_CHANGED',
      cameraCode: 'CAM-001',
      cameraId: zone.id, // closest camera (loadtest approximation)
      zoneId: zone.id,
      tableId: zone.tableId,
      peopleCount: people,
      confidence: 0.9,
      detectedAt: new Date(),
      outcome: 'applied',
      model: 'loadtest-sim',
    },
  })
}

// weighted op selection: 35/20/15/20/10
function pickOp(): { name: OpName; fn: () => Promise<void> } {
  const r = Math.random()
  if (r < 0.35) return { name: 'kds_poll', fn: opKdsPoll }
  if (r < 0.55) return { name: 'pos_catalog', fn: opPosCatalog }
  if (r < 0.7) return { name: 'floor_state', fn: opFloorState }
  if (r < 0.9) return { name: 'order_cycle', fn: opOrderCycle }
  return { name: 'vision_ingest', fn: opVisionIngest }
}

async function main(): Promise<void> {
  if (args.includes('--cleanup')) {
    const orders = await db.order.findMany({ where: { externalRef: { startsWith: 'loadtest-' } }, select: { id: true } })
    const r1 = await db.order.deleteMany({ where: { externalRef: { startsWith: 'loadtest-' } } })
    const r2 = await db.visionEvent.deleteMany({ where: { eventId: { startsWith: 'loadtest-' } } })
    await db.auditLog.create({
      data: {
        userId: 1,
        userName: 'loadtest',
        action: 'loadtest.cleanup',
        entity: 'system',
        entityId: null,
        details: `load-test data removed: ${r1.count} orders (cascade items/payments), ${r2.count} vision events`,
      },
    })
    console.log(JSON.stringify({ cleanup: { orders: r1.count, visionEvents: r2.count, idsBefore: orders.length } }))
    return
  }

  const duration = Number(args[0] ?? 30)
  const workers = Number(args[1] ?? 8)
  const label = args[2] ?? 'run'

  const jm = await db.$queryRawUnsafe<{ journal_mode: string }[]>('PRAGMA journal_mode')
  console.error(`[${label}] journal_mode=${jm[0]?.journal_mode} · ${workers} workers · ${duration}s`)

  const samples: Sample[] = []
  const deadline = Date.now() + duration * 1000
  let seq = 0

  async function worker(): Promise<void> {
    while (Date.now() < deadline) {
      const { name, fn } = pickOp()
      const t0 = performance.now()
      try {
        await fn()
        samples.push({ op: name, ms: performance.now() - t0, ok: true })
      } catch (e) {
        samples.push({ op: name, ms: performance.now() - t0, ok: false, err: classifyError(e) })
      }
      seq++
      // tiny breath so pure-read loops don't starve the event loop
      if (seq % 3 === 0) await new Promise((r) => setTimeout(r, 1))
    }
  }

  const t0 = Date.now()
  await Promise.all(Array.from({ length: workers }, () => worker()))
  const wall = (Date.now() - t0) / 1000

  // aggregate
  const ops: Record<string, { count: number; ok: number; err: number; lat: number[]; errs: Record<string, number> }> = {}
  for (const s of samples) {
    const o = (ops[s.op] ??= { count: 0, ok: 0, err: 0, lat: [], errs: {} })
    o.count++
    if (s.ok) o.ok++
    else {
      o.err++
      o.errs[s.err ?? 'unknown'] = (o.errs[s.err ?? 'unknown'] ?? 0) + 1
    }
    o.lat.push(s.ms)
  }
  const report: Record<string, unknown> = {
    label,
    journalMode: jm[0]?.journal_mode,
    workers,
    durationSec: wall,
    totalOps: samples.length,
    opsPerSec: Math.round((samples.length / wall) * 10) / 10,
    totalErrors: samples.filter((s) => !s.ok).length,
    errorRate: samples.length ? Math.round((samples.filter((s) => !s.ok).length / samples.length) * 10000) / 100 : 0,
    ops: {},
  }
  for (const [name, o] of Object.entries(ops)) {
    const sorted = [...o.lat].sort((x, y) => x - y)
    ;(report.ops as Record<string, unknown>)[name] = {
      count: o.count,
      ok: o.ok,
      errors: o.err,
      errorTypes: o.errs,
      p50ms: Math.round(pct(sorted, 50) * 10) / 10,
      p95ms: Math.round(pct(sorted, 95) * 10) / 10,
      p99ms: Math.round(pct(sorted, 99) * 10) / 10,
      maxMs: Math.round(sorted[sorted.length - 1] * 10) / 10,
    }
  }
  console.log(JSON.stringify(report, null, 1))
}

main().finally(() => db.$disconnect())
