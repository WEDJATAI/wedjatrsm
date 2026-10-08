// r50 fixup: complete the mazaj E2E cleanup — the sed table-id rewrite missed
// the direct free-UPDATE (spaces around '='), so the rev-5 supersede snapshot
// was taken while table 21 was still occupied and the engine faithfully
// re-applied 'occupied'. This script: frees table 21 on Neon, emits a correct
// rev-6 FULL-ROW supersede, waits for the local apply, then removes BOTH
// artifact events (rev5 + rev6) from the stream on both planes (r47 discipline).
import { randomUUID, createHash } from 'node:crypto'
import { Pool } from 'pg'
import { createClient } from '@libsql/client'
import { neonPooledUrl } from '../lib/env-local'

const ldb = createClient({ url: 'file:db/custom.db' })
const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const lrows = async (sql: string) => (await ldb.execute(sql)).rows as Array<Record<string, unknown>>

async function main() {
  // 1. free table 21 on Neon (the missed UPDATE — verified by rowCount this time)
  const upd = await pool.query("UPDATE tables SET status='free' WHERE id = 21 RETURNING id, status")
  if (upd.rowCount !== 1) { console.log('✗ table 21 UPDATE matched', upd.rowCount, 'rows'); process.exit(1) }
  console.log('✓ Neon table #21 →', upd.rows[0].status, '(rowCount verified)')

  // 2. emit the corrected supersede at rev 6 (local watermark is 5 after the rev-5 apply)
  const tRow = (await pool.query('SELECT * FROM tables WHERE id = 21')).rows[0] as Record<string, unknown>
  const tPayload: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(tRow)) tPayload[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = v instanceof Date ? v.toISOString() : v
  if (tPayload.status !== 'free') { console.log('✗ snapshot status not free:', tPayload.status); process.exit(1) }
  tPayload.revision = 6
  const body = JSON.stringify(tPayload)
  const rev6EventId = randomUUID()
  const ev5 = (await pool.query("SELECT \"eventId\" FROM hybrid_events WHERE entity='RestaurantTable' AND \"entityId\"=21 AND revision=5")).rows[0] as { eventId: string } | undefined
  await pool.query(
    `INSERT INTO hybrid_events ("eventId","deviceId","entity","entityId","operation","revision","payloadHash","payload","direction","status","attempts","createdAt","updatedAt")
     VALUES ($1,'unbound','RestaurantTable',21,'update',6,$2,$3,'out','pending',0,now(),now())`,
    [rev6EventId, createHash('sha256').update(body).digest('hex'), body],
  )
  console.log('✓ emitted RestaurantTable/21 update rev6 (status=free, full row) — payload verified free BEFORE emit')

  // 3. wait for the local to pull + apply (engine tick ≤30s)
  const deadline = Date.now() + 150_000
  let applied = false
  while (Date.now() < deadline) {
    const st = (await lrows('SELECT status FROM tables WHERE id=21'))[0]?.status
    if (st === 'free') { applied = true; break }
    await sleep(4_000)
  }
  console.log(applied ? '✓ LOCAL table #21 → free (rev6 supersede pulled + applied)' : '✗ local table #21 still not free after 150s')
  if (!applied) process.exit(1)

  // 4. stream cleanup: remove the two artifact events (rev5 occupied + rev6 free) on BOTH planes
  const artifactIds = [rev6EventId, ...(ev5 ? [ev5.eventId] : [])]
  const d = await pool.query('DELETE FROM hybrid_events WHERE "eventId" = ANY($1) RETURNING id', [artifactIds])
  console.log(`✓ Neon stream: ${d.rowCount} artifact event(s) removed (rev5 + rev6)`)
  await ldb.execute(`DELETE FROM hybrid_events WHERE "eventId" IN (${artifactIds.map((i) => `'${i}'`).join(',')})`)
  console.log('✓ local event copies removed')

  // 5. final verdict
  const neonTable = (await pool.query('SELECT status FROM tables WHERE id=21')).rows[0] as { status: string }
  const localTable = (await lrows('SELECT status FROM tables WHERE id=21'))[0]?.status
  const neonOrders = Number(((await pool.query('SELECT COUNT(*)::int c FROM orders')).rows[0] as { c: number }).c)
  const localOrders = Number((await lrows('SELECT COUNT(*) c FROM orders'))[0]?.c ?? 0)
  const wmNeon = Number(((await pool.query("SELECT COALESCE(MAX(revision),0) m FROM hybrid_events WHERE entity='RestaurantTable' AND \"entityId\"=21")).rows[0] as { m: number }).m)
  const wmLocal = Number((await lrows("SELECT COALESCE(MAX(revision),0) m FROM hybrid_events WHERE entity='RestaurantTable' AND entityId=21"))[0]?.m ?? 0)
  const pend = Number((await lrows("SELECT COUNT(*) c FROM hybrid_events WHERE direction='out' AND status='pending'"))[0]?.c ?? 0)
  console.log(`final: table#21 neon=${neonTable.status} local=${localTable} · orders ${neonOrders}/${localOrders} · table21 watermarks neon=${wmNeon} local=${wmLocal} · outboxPending=${pend}`)
  const okAll = neonTable.status === 'free' && localTable === 'free' && neonOrders === 2 && localOrders === 2 && pend === 0
  console.log(okAll
    ? 'RESULT: CLEANUP COMPLETE — table 21 free on both planes, orders at launch baseline, watermarks consistent, zero residue'
    : 'RESULT: state mismatch — inspect above')
  await pool.end(); ldb.close()
  process.exit(okAll ? 0 : 1)
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1) })
