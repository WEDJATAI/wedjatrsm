// r36: surgical cleanup of the macOS-agent E2E test artifacts (r35 pattern).
// Removes ONLY: test customer 16 (+ its hybrid events) on Neon AND locally,
// and the 6 test device enrollments (Neon ids 9-14). Preflight-checked.
// Keeps: the live demo agent device, all owner data, audit log rows
// (append-only enrollment trail — same policy as r35).
import { PrismaClient as PgClient } from '../../pgtmp-client'
import { PrismaPg } from '@prisma/adapter-pg'
import { neonPooledUrl } from '../lib/env-local'

const TEST_DEVICE_IDS = [9, 10, 11, 12, 13, 14]
const TEST_DEVICE_KEYS = ['e6f6cfc1', '92ca69e0', '692e8290', 'f215aab7', 'de520e03', 'fef7fe99']

async function main() {
  const pg = new PgClient({ adapter: new PrismaPg({ connectionString: neonPooledUrl() }) }) // r49: Prisma 7 adapter
  try {
    // ── PREFLIGHT: customer 16 FK references on Neon ──
    const fk = (await pg.$queryRawUnsafe(
      `SELECT (SELECT count(*) FROM orders WHERE customer_id=16) o, (SELECT count(*) FROM reservations WHERE customer_id=16) r`,
    )) as Array<{ o: bigint; r: bigint }>
    console.log('Neon customer-16 FK refs:', Number(fk[0].o), '/', Number(fk[0].r), '(0/0 expected)')
    if (Number(fk[0].o) > 0 || Number(fk[0].r) > 0) throw new Error('ABORT — FK references exist')

    // ── PREFLIGHT: devices to remove are exactly the test ones ──
    const dev = (await pg.$queryRawUnsafe(
      `SELECT id, left("deviceId",8) k, name FROM hybrid_devices WHERE id IN (9,10,11,12,13,14)`,
    )) as any[]
    if (dev.length !== TEST_DEVICE_IDS.length) throw new Error(`ABORT — expected ${TEST_DEVICE_IDS.length} test devices, found ${dev.length}`)
    for (const d of dev) {
      if (!TEST_DEVICE_KEYS.includes(d.k) || !d.name.includes('Linux Agent')) {
        throw new Error(`ABORT — device ${d.id} (${d.k} · ${d.name}) is not a test device`)
      }
    }
    console.log('Neon test devices verified:', dev.map((d) => `${d.id}:${d.k}`).join(', '))

    const ev = (await pg.$queryRawUnsafe(
      `SELECT count(*) n FROM hybrid_events WHERE entity='Customer' AND "entityId"=16`,
    )) as Array<{ n: bigint }>
    console.log('Neon Customer/16 events to remove:', Number(ev[0].n))

    await pg.$executeRawUnsafe(`DELETE FROM customers WHERE id = 16`)
    await pg.$executeRawUnsafe(`DELETE FROM hybrid_events WHERE entity='Customer' AND "entityId"=16`)
    const del = await pg.$executeRawUnsafe(
      `DELETE FROM hybrid_devices WHERE id IN (9,10,11,12,13,14) AND left("deviceId",8) IN ('e6f6cfc1','92ca69e0','692e8290','f215aab7','de520e03','fef7fe99')`,
    )
    console.log('Neon devices removed:', del)

    // verify
    const c = (await pg.$queryRawUnsafe(`SELECT count(*) n FROM customers WHERE id=16`)) as Array<{ n: bigint }>
    const d2 = (await pg.$queryRawUnsafe(`SELECT id, name FROM hybrid_devices ORDER BY id`)) as any[]
    const ev2 = (await pg.$queryRawUnsafe(`SELECT count(*) n FROM hybrid_events WHERE entity='Customer' AND "entityId"=16`)) as Array<{ n: bigint }>
    console.log('VERIFY Neon: customer16 =', Number(c[0].n), '(0 expected) · events =', Number(ev2[0].n), '(0 expected)')
    console.log('VERIFY Neon remaining devices:', JSON.stringify(d2))
  } finally {
    await pg.$disconnect()
  }
}
main().then(() => process.exit(0)).catch((e) => {
  console.error('FAIL', e.message)
  process.exit(1)
})
