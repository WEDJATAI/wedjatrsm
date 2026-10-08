/**
 * R30 hybrid sync — PROTOCOL VERIFICATION SCRIPT.
 *
 * Run against the RUNNING dev server:
 *   bun scripts/hybrid-demo.ts
 *
 * Exercises the full rsm-hybrid/1 protocol surface end-to-end over HTTP
 * (unauthenticated rejection → admin login → device registration → push
 * batch → duplicate-delivery idempotency → cross-device pull isolation →
 * append-only policy enforcement → status snapshot → cleanup), verifying
 * database effects directly via Prisma between steps. Prints PASS/FAIL per
 * step and exits non-zero on any failure.
 */
import { randomUUID } from 'node:crypto'
import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'

import { canonicalJson, sha256Hex } from '../src/lib/hybrid-sync/serialization'

const BASE = process.env.HYBRID_DEMO_BASE ?? 'http://localhost:3000'
const ADMIN_EMAIL = 'admin@rms.com'
const ADMIN_PASSWORD = 'admin123'

const db = new PrismaClient({ adapter: new PrismaLibSql({ url: (process.env.DATABASE_URL ?? 'file:./db/custom.db').split('?')[0] }), log: ['error'] }) // r49: Prisma 7 adapter

let sessionCookie: string | null = null
let deviceA: { deviceId: string; deviceKey: string } | null = null
let deviceB: { deviceId: string; deviceKey: string } | null = null
const failures: string[] = []

function pass(step: string, detail = ''): void {
  console.log(`  PASS  ${step}${detail ? ` — ${detail}` : ''}`)
}

function fail(step: string, detail = ''): void {
  console.error(`  FAIL  ${step}${detail ? ` — ${detail}` : ''}`)
  failures.push(step)
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch (err) {
    fail(name, err instanceof Error ? err.message : String(err))
    return null
  }
}

function deviceHeaders(device: { deviceId: string; deviceKey: string }): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-hybrid-device': device.deviceId,
    'x-hybrid-key': device.deviceKey,
  }
}

function customerPayload(id: number, name: string): Record<string, unknown> {
  return {
    id,
    name,
    phone: `0100009${String(id).slice(-4)}`,
    visits: 2,
    points: 45.5,
    totalSpent: 990.25,
    lastVisitAt: '2026-01-15T18:30:00.000Z',
    notes: 'hybrid protocol test customer',
    active: true,
    createdAt: '2026-01-10T12:00:00.000Z',
  }
}

type WireEvent = {
  eventId: string
  deviceId: string
  entity: string
  entityId: number
  operation: 'create' | 'update' | 'delete'
  revision: number
  payloadHash: string
  payload: Record<string, unknown>
  createdAt: string
}

function makeEvent(
  device: { deviceId: string },
  entity: string,
  entityId: number,
  operation: 'create' | 'update' | 'delete',
  payload: Record<string, unknown>,
  revision = 1,
  eventId = randomUUID(),
): WireEvent {
  return {
    eventId,
    deviceId: device.deviceId,
    entity,
    entityId,
    operation,
    revision,
    payloadHash: sha256Hex(canonicalJson(payload)),
    payload,
    createdAt: new Date().toISOString(),
  }
}

async function main(): Promise<void> {
  console.log(`[hybrid-demo] target: ${BASE}`)

  // ── 1) unauthenticated status must be rejected ──────────────────────
  await step('1. status unauthenticated → 401', async () => {
    const res = await fetch(`${BASE}/api/hybrid/status`)
    if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`)
    pass('1. status unauthenticated → 401')
  })

  // ── 2) admin login (capture session cookie) ─────────────────────────
  await step('2. admin login', async () => {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
    })
    if (res.status !== 200) throw new Error(`login failed with ${res.status}`)
    const setCookie = res.headers.get('set-cookie') ?? ''
    const match = /rms_session=([^;]+)/.exec(setCookie)
    if (!match) throw new Error('no rms_session cookie in login response')
    sessionCookie = match[1]
    const body = (await res.json()) as { user?: { name?: string } }
    pass('2. admin login', `session for ${body.user?.name ?? ADMIN_EMAIL}`)
  })
  if (!sessionCookie) return finish()

  // ── 3) register device A ────────────────────────────────────────────
  await step('3. register device A', async () => {
    const res = await fetch(`${BASE}/api/hybrid/device`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `rms_session=${sessionCookie}` },
      body: JSON.stringify({ name: 'Protocol Test Device' }),
    })
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`)
    const body = (await res.json()) as { deviceId?: string; deviceKey?: string }
    if (!body.deviceId || !body.deviceKey || body.deviceKey.length !== 64) {
      throw new Error('deviceId/deviceKey missing or key not 64-hex')
    }
    deviceA = { deviceId: body.deviceId, deviceKey: body.deviceKey }
    pass('3. register device A', `${body.deviceId.slice(0, 8)}…`)
  })
  if (!deviceA) return finish()

  // ── 4) push a batch of 2 Customer creates → both acked ──────────────
  const deviceARef = deviceA // narrowed for the closures below (TS: module-level let)
  if (!deviceARef) return finish()
  const batchEvents: WireEvent[] = [
    makeEvent(deviceARef, 'Customer', 990001, 'create', customerPayload(990001, 'Protocol Test One')),
    makeEvent(deviceARef, 'Customer', 990002, 'create', customerPayload(990002, 'Protocol Test Two')),
  ]
  await step('4. push batch of 2 Customer creates → 200, both acked', async () => {
    const res = await fetch(`${BASE}/api/hybrid/push`, {
      method: 'POST',
      headers: deviceHeaders(deviceARef),
      body: JSON.stringify({ batchId: randomUUID(), deviceId: deviceARef.deviceId, events: batchEvents }),
    })
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${await res.text()}`)
    const body = (await res.json()) as { acked?: string[]; rejected?: unknown[]; conflicts?: unknown[] }
    const ackedIds = new Set(body.acked ?? [])
    if (ackedIds.size !== 2 || !batchEvents.every((e) => ackedIds.has(e.eventId))) {
      throw new Error(`expected both acked, got acked=${JSON.stringify(body.acked)} rejected=${JSON.stringify(body.rejected)}`)
    }
    const c1 = await db.customer.findUnique({ where: { id: 990001 } })
    if (!c1 || c1.name !== 'Protocol Test One') throw new Error('customer 990001 not applied')
    pass('4. push batch of 2 Customer creates → 200, both acked')
  })

  // ── 5) duplicate delivery of the SAME batch → acked again, still 1 row ─
  await step('5. duplicate push (idempotency) → acked, customer count still 1', async () => {
    const res = await fetch(`${BASE}/api/hybrid/push`, {
      method: 'POST',
      headers: deviceHeaders(deviceARef),
      body: JSON.stringify({ batchId: randomUUID(), deviceId: deviceARef.deviceId, events: batchEvents }),
    })
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`)
    const body = (await res.json()) as { acked?: string[] }
    if ((body.acked ?? []).length !== 2) throw new Error(`expected 2 acked, got ${JSON.stringify(body.acked)}`)
    const count = await db.customer.count({ where: { id: 990001 } })
    if (count !== 1) throw new Error(`customer 990001 count = ${count}, expected 1`)
    pass('5. duplicate push (idempotency) → acked, customer count still 1')
  })

  // ── 6) cross-device pull isolation ──────────────────────────────────
  await step("6. pull as A contains B's event, never A's own", async () => {
    // register device B
    const regRes = await fetch(`${BASE}/api/hybrid/device`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `rms_session=${sessionCookie}` },
      body: JSON.stringify({ name: 'Protocol Test Device B' }),
    })
    if (regRes.status !== 200) throw new Error(`device B registration failed: ${regRes.status}`)
    const regBody = (await regRes.json()) as { deviceId: string; deviceKey: string }
    deviceB = { deviceId: regBody.deviceId, deviceKey: regBody.deviceKey }
    if (!deviceB) throw new Error('device B missing')

    // B pushes one event (Customer 990003)
    const bEvent = makeEvent(deviceB, 'Customer', 990003, 'create', customerPayload(990003, 'Protocol Test Three'))
    const pushRes = await fetch(`${BASE}/api/hybrid/push`, {
      method: 'POST',
      headers: deviceHeaders(deviceB),
      body: JSON.stringify({ batchId: randomUUID(), deviceId: deviceB.deviceId, events: [bEvent] }),
    })
    if (pushRes.status !== 200) throw new Error(`B push failed: ${pushRes.status}`)

    // A pulls — must see B's event, none of its own
    const pullRes = await fetch(`${BASE}/api/hybrid/pull?cursor=0&limit=100`, {
      headers: deviceHeaders(deviceARef),
    })
    if (pullRes.status !== 200) throw new Error(`pull failed: ${pullRes.status}`)
    const pullBody = (await pullRes.json()) as {
      events?: Array<{ eventId: string; entity: string; entityId: number }>
      nextCursor?: number
      remaining?: number
    }
    const events = pullBody.events ?? []
    const hasBs = events.some((e) => e.eventId === bEvent.eventId && e.entityId === 990003)
    const ownLeaked = events.filter((e) => batchEvents.some((b) => b.eventId === e.eventId))
    if (!hasBs) throw new Error(`B's event missing from A's pull (got ${events.length} events)`)
    if (ownLeaked.length > 0) throw new Error(`A pulled its OWN events: ${ownLeaked.map((e) => e.eventId).join(', ')}`)
    if (typeof pullBody.nextCursor !== 'number' || typeof pullBody.remaining !== 'number') {
      throw new Error('pull response missing nextCursor/remaining')
    }
    pass("6. pull as A contains B's event, never A's own", `${events.length} event(s) delivered`)
  })

  // ── 7) append-only policy: Payment update must be rejected, not applied ─
  await step('7. Payment update (append-only) → conflict recorded, NOT applied', async () => {
    const paymentEvent = makeEvent(
      deviceARef,
      'Payment',
      990099,
      'update',
      {
        id: 990099,
        orderId: 1,
        method: 'cash',
        amount: 123.45,
        tip: 0,
        reference: 'PROTOCOL-TEST',
        amountTendered: 0,
        changeGiven: 0,
        createdAt: '2026-01-15T19:00:00.000Z',
      },
      1,
    )
    const res = await fetch(`${BASE}/api/hybrid/push`, {
      method: 'POST',
      headers: deviceHeaders(deviceARef),
      body: JSON.stringify({ batchId: randomUUID(), deviceId: deviceARef.deviceId, events: [paymentEvent] }),
    })
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`)
    const body = (await res.json()) as {
      acked?: string[]
      conflicts?: Array<{ eventId: string; resolution: string }>
    }
    if (!(body.acked ?? []).includes(paymentEvent.eventId)) {
      throw new Error('append-only violation not acked-as-processed')
    }
    const conflictRow = await db.hybridConflict.findUnique({ where: { eventId: paymentEvent.eventId } })
    if (!conflictRow || conflictRow.resolution !== 'rejected') {
      throw new Error(`expected HybridConflict resolution 'rejected', got ${conflictRow ? conflictRow.resolution : 'none'}`)
    }
    const paymentRow = await db.payment.findUnique({ where: { id: 990099 } })
    if (paymentRow) throw new Error('Payment 990099 was APPLIED — append-only policy violated!')
    pass('7. Payment update (append-only) → conflict recorded, NOT applied')
  })

  // ── 8) status snapshot shape ────────────────────────────────────────
  await step('8. status with admin session → 200 + counts shape', async () => {
    const res = await fetch(`${BASE}/api/hybrid/status`, {
      headers: { cookie: `rms_session=${sessionCookie}` },
    })
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`)
    const body = (await res.json()) as {
      version?: string
      engine?: string
      counts?: Record<string, number>
      cloud?: unknown
      internet?: string
    }
    if (body.version !== 'rsm-hybrid/1') throw new Error(`version = ${body.version}`)
    if (!body.counts || typeof body.counts.pendingUploads !== 'number') {
      throw new Error('counts object missing or malformed')
    }
    if (typeof body.internet !== 'string') throw new Error('internet verdict missing')
    pass('8. status with admin session → 200 + counts shape', `engine=${body.engine}, internet=${body.internet}`)
  })

  // ── 9) cleanup + DB-clean verification ──────────────────────────────
  await step('9. cleanup + DB-clean verification', async () => {
    const testEntityIds = [990001, 990002, 990003, 990099]
    await db.customer.deleteMany({ where: { id: { in: testEntityIds } } })
    await db.hybridConflict.deleteMany({ where: { entityId: { in: testEntityIds } } })
    await db.hybridEvent.deleteMany({ where: { entityId: { in: testEntityIds } } })
    if (deviceA) await db.hybridDevice.deleteMany({ where: { deviceId: deviceA.deviceId } })
    if (deviceB) await db.hybridDevice.deleteMany({ where: { deviceId: deviceB.deviceId } })

    const [customers, events, conflicts, devices] = await Promise.all([
      db.customer.count({ where: { id: { in: testEntityIds } } }),
      db.hybridEvent.count({ where: { entityId: { in: testEntityIds } } }),
      db.hybridConflict.count({ where: { entityId: { in: testEntityIds } } }),
      db.hybridDevice.count({
        where: { name: { in: ['Protocol Test Device', 'Protocol Test Device B'] } },
      }),
    ])
    if (customers !== 0 || events !== 0 || conflicts !== 0 || devices !== 0) {
      throw new Error(`DB not clean: customers=${customers} events=${events} conflicts=${conflicts} devices=${devices}`)
    }
    pass('9. cleanup + DB-clean verification', 'customers/events/conflicts/devices all 0')
  })

  await finish()
}

async function finish(): Promise<void> {
  await db.$disconnect()
  if (failures.length === 0) {
    console.log('HYBRID PROTOCOL: ALL PASS')
    process.exit(0)
  }
  console.error(`FAILED: ${failures.join(' | ')}`)
  process.exit(1)
}

main().catch((err) => {
  console.error('[hybrid-demo] crashed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
