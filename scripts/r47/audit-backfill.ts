// r47: backfill the 7 cloud-origin audit rows (missing locally after the 12th recycle)
// through the STANDARD event path — cloud-origin AuditLog events on Neon → engine pull → apply.
// Pattern: scripts/r42/roundtrip.ts (cloud-side write = row already on Neon + outbox event).
import { Client } from 'pg'
import { createHash, randomUUID } from 'crypto'
import { readFileSync } from 'fs'

const env = Object.fromEntries(
  readFileSync('.env.deploy-local', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] })
)

const snakeToCamel = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase())

async function main() {
  const pool = new Client({ connectionString: env.NEON_DATABASE_URL })
  await pool.connect()

  // 1. find audit rows on Neon that are missing locally
  const { rows: neonRows } = await pool.query('SELECT * FROM audit_logs ORDER BY id')
  const { createClient } = await import('@libsql/client')
  const ldb = createClient({ url: 'file:db/custom.db' })
  const localIds = new Set((await ldb.execute('SELECT id FROM audit_logs')).rows.map((r) => Number(r.id)))
  const missing = neonRows.filter((r) => !localIds.has(r.id))
  console.log(`Neon audit=${neonRows.length} local audit=${localIds.size} missing=${missing.length}`)
  if (missing.length === 0) { await pool.end(); ldb.close(); return }

  // 2. emit one cloud-origin AuditLog outbox event per missing row (canonical r42 shape)
  for (const row of missing) {
    const camel: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(row)) camel[snakeToCamel(k)] = v instanceof Date ? v.toISOString() : v
    const payload = JSON.stringify(camel)
    const payloadHash = createHash('sha256').update(payload).digest('hex')
    await pool.query(
      `INSERT INTO hybrid_events ("eventId","deviceId","entity","entityId","operation","revision","payloadHash","payload","direction","status","attempts","createdAt","updatedAt")
       VALUES ($1,'unbound','AuditLog',$2,'create',1,$3,$4,'out','pending',0,now(),now())`,
      [randomUUID(), String(row.id), payloadHash, payload],
    )
    console.log(`  emitted AuditLog#${row.id} (${row.action})`)
  }
  await pool.end()

  // 3. wait for the local engine to pull + apply them (pull cycle every 30s)
  const deadline = Date.now() + 150_000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10_000))
    const after = (await ldb.execute('SELECT COUNT(*) c FROM audit_logs')).rows[0]
    const remaining = missing.filter((m) => !Number(after.c) || false).length // placeholder
    const nowIds = new Set((await ldb.execute('SELECT id FROM audit_logs')).rows.map((r) => Number(r.id)))
    const stillMissing = missing.filter((m) => !nowIds.has(m.id))
    console.log(`  ...local audit=${after.c}, still missing=${stillMissing.length}`)
    if (stillMissing.length === 0) { console.log('ALL BACKFILLED — local == Neon audit parity'); break }
  }
  ldb.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
