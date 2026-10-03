// r35: surgical Neon cleanup of the agent E2E test artifacts.
// Removes ONLY: test customer 15 (+ its hybrid events) and the superseded test
// device 0c4d9071. Renames the live demo agent device. All preflight-checked.
import { PrismaClient as PgClient } from '../../pgtmp-client'
import { neonPooledUrl } from '../lib/env-local'

async function main() {
  const pg = new PgClient({ datasources: { db: { url: neonPooledUrl() } } })
  try {
    // PREFLIGHT: customer 15 FK references on Neon (orders / reservations)
    const fk = (await pg.$queryRawUnsafe(
      `SELECT (SELECT count(*) FROM orders WHERE customer_id=15) o, (SELECT count(*) FROM reservations WHERE customer_id=15) r`,
    )) as Array<{ o: bigint; r: bigint }>
    console.log('Neon customer-15 FK refs:', Number(fk[0].o), '/', Number(fk[0].r), '(0/0 expected)')
    if (Number(fk[0].o) > 0 || Number(fk[0].r) > 0) throw new Error('ABORT — FK references exist')

    // PREFLIGHT: conflicts referencing Customer/15
    const cf = (await pg.$queryRawUnsafe(
      `SELECT count(*) n FROM hybrid_conflicts WHERE entity='Customer' AND "entityId"=15`,
    )) as Array<{ n: bigint }>
    console.log('Neon conflicts for Customer/15:', Number(cf[0].n), '(0 expected)')
    if (Number(cf[0].n) > 0) throw new Error('ABORT — conflict rows exist')

    const ev = (await pg.$queryRawUnsafe(
      `SELECT count(*) n FROM hybrid_events WHERE entity='Customer' AND "entityId"=15`,
    )) as Array<{ n: bigint }>
    console.log('Neon Customer/15 events to remove:', Number(ev[0].n))

    await pg.$executeRawUnsafe(`DELETE FROM customers WHERE id = 15`)
    await pg.$executeRawUnsafe(`DELETE FROM hybrid_events WHERE entity='Customer' AND "entityId"=15`)
    await pg.$executeRawUnsafe(`DELETE FROM hybrid_devices WHERE "deviceId" LIKE '0c4d9071%'`)
    await pg.$executeRawUnsafe(`UPDATE hybrid_devices SET name = 'Sandbox Live Agent (E2E demo)' WHERE "deviceId" LIKE '9567fe1d%'`)

    console.log('--- NEON after cleanup ---')
    const d = (await pg.$queryRawUnsafe(
      `SELECT id, "deviceId", name, platform, status FROM hybrid_devices ORDER BY id`,
    )) as Array<{ id: number; deviceId: string; name: string; platform: string; status: string }>
    for (const r of d) console.log('  device:', [r.id, r.deviceId.slice(0, 8), r.name, r.platform, r.status].join(' | '))

    const checks: Array<[string, string, number]> = [
      ['customer 15 remaining', `SELECT count(*) n FROM customers WHERE id=15`, 0],
      ['Customer/15 events remaining', `SELECT count(*) n FROM hybrid_events WHERE entity='Customer' AND "entityId"=15`, 0],
      ['customers total', `SELECT count(*) n FROM customers`, 4],
      ['orders total', `SELECT count(*) n FROM orders`, 1044],
    ]
    for (const [label, sql, want] of checks) {
      const r = (await pg.$queryRawUnsafe(sql)) as Array<{ n: bigint }>
      const got = Number(r[0].n)
      console.log(`${label}: ${got} (want ${want}) ${got === want ? 'OK' : 'MISMATCH'}`)
    }
  } finally {
    await pg.$disconnect()
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('FAIL', e.message)
    process.exit(1)
  })
