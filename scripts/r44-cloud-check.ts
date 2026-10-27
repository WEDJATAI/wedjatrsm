/**
 * r44 — CLOUD CHECK: latest updates from Neon (the authoritative cloud DB)
 * and verification that local has them applied correctly. Read-only.
 */
import { Database } from 'bun:sqlite'
import { Pool } from 'pg'
import { neonPooledUrl } from './lib/env-local'

const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
const local = new Database('/home/z/my-project/db/custom.db', { readonly: true })

async function main() {
  console.log('=== r44 CLOUD CHECK (Neon authoritative) ===')

  // ── 1) Neon engine stream: max id + latest events ──
  const maxRow = await pool.query("SELECT MAX(id) AS max FROM hybrid_events WHERE direction='out'")
  const neonMax = maxRow.rows[0].max as number | null
  console.log(`Neon hybrid_events (direction=out) max id: ${neonMax}`)

  const cursorRow = await pool.query('SELECT COUNT(*) AS c FROM hybrid_events')
  console.log(`Neon hybrid_events total rows: ${cursorRow.rows[0].c}`)

  const latest = await pool.query(
    `SELECT id, "eventId", "deviceId", entity, "entityId", operation, status, created_at
     FROM hybrid_events WHERE direction='out' ORDER BY id DESC LIMIT 12`
  )
  console.log('\n── Latest 12 cloud stream events (what devices pull) ──')
  for (const r of latest.rows) {
    console.log(
      `  #${r.id} ${new Date(r.created_at).toISOString().slice(0, 19)} ${r.entity}/${r.entityId} ${r.operation} dev=${String(r.deviceId).slice(0, 12)} status=${r.status}`
    )
  }

  // local cursor
  const localCursor = local
    .query("SELECT value FROM hybrid_sync_state WHERE key='pull.cursor'")
    .get() as any
  const localRemaining = local
    .query("SELECT value FROM hybrid_sync_state WHERE key='pull.remaining'")
    .get() as any
  console.log(`\nLocal pull cursor: ${localCursor.value} | pull.remaining: ${localRemaining.value}`)
  console.log(
    neonMax !== null && Number(localCursor.value) >= neonMax
      ? `✓ LOCAL IS CURRENT: cursor ${localCursor.value} >= Neon max ${neonMax} — every cloud event is pulled`
      : `✗ LOCAL BEHIND: cursor ${localCursor.value} < Neon max ${neonMax}`
  )

  // any pending cloud events the local hasn't pulled? (un-acked device events on cloud)
  const unAcked = await pool.query(
    "SELECT id, entity, \"entityId\", operation, status, \"deviceId\", created_at FROM hybrid_events WHERE direction='out' AND id > $1 ORDER BY id LIMIT 10",
    [Number(localCursor.value)]
  )
  console.log(
    unAcked.rows.length === 0
      ? '✓ No cloud events beyond the local cursor (nothing waiting to be pulled)'
      : `Events beyond cursor: ${JSON.stringify(unAcked.rows, null, 1)}`
  )

  // ── 2) Neon business counts vs local ──
  console.log('\n── Business parity: Neon vs Local ──')
  const countPairs: Array<[string, string]> = [
    ['users', 'users'],
    ['products', 'products'],
    ['categories', 'categories'],
    ['orders', 'orders'],
    ['order_items', 'order_items'],
    ['customers', 'customers'],
    ['audit_logs', 'audit_logs'],
    ['tables', 'tables'],
    ['suppliers', 'suppliers'],
    ['modifier_groups', 'modifier_groups'],
    ['modifiers', 'modifiers'],
    ['attendance', 'attendance'],
    ['reservations', 'reservations'],
    ['promotions', 'promotions'],
  ]
  let mismatches = 0
  for (const [t, lt] of countPairs) {
    const n = (await pool.query(`SELECT COUNT(*) c FROM ${t}`)).rows[0].c
    const l = (local.query(`SELECT COUNT(*) c FROM ${lt}`).get() as any).c
    const ok = Number(n) === Number(l)
    if (!ok) mismatches++
    console.log(`  ${ok ? '✓' : '✗'} ${t}: Neon=${n} Local=${l}`)
  }
  console.log(mismatches === 0 ? '✓ ALL COUNTS MATCH' : `✗ ${mismatches} TABLE(S) MISMATCH`)

  // ── 3) Spot-check today's synced updates (did they apply IDENTICALLY?) ──
  console.log('\n── Spot checks (today\'s cloud→local traffic) ──')
  // Modifier 49/50 + ModifierGroup 16 deleted cloud-side at 03:59
  const modNeon = await pool.query('SELECT id FROM modifiers WHERE id IN (49,50)')
  const modGrpNeon = await pool.query('SELECT id FROM modifier_groups WHERE id = 16')
  const modLocal = local.query('SELECT id FROM modifiers WHERE id IN (49,50)').all()
  const modGrpLocal = local.query('SELECT id FROM modifier_groups WHERE id = 16').all()
  console.log(
    `  Modifier 49/50: Neon rows=${modNeon.rows.length}, Local rows=${modLocal.length} ${modNeon.rows.length === modLocal.length ? '✓' : '✗'}`
  )
  console.log(
    `  ModifierGroup 16: Neon rows=${modGrpNeon.rows.length}, Local rows=${modGrpLocal.length} ${modGrpNeon.rows.length === modGrpLocal.length ? '✓' : '✗'}`
  )

  // Customer 30 deleted at 07:52 (probe cleanup)
  const custNeon = await pool.query('SELECT id FROM customers WHERE id = 30')
  const custLocal = local.query('SELECT id FROM customers WHERE id = 30').all()
  console.log(
    `  Customer 30 (probe cleanup): Neon rows=${custNeon.rows.length}, Local rows=${custLocal.length} ${custNeon.rows.length === custLocal.length ? '✓' : '✗'}`
  )

  // Supplier 3 deleted at 11:49 (probe cleanup)
  const supNeon = await pool.query('SELECT id FROM suppliers WHERE id = 3')
  const supLocal = local.query('SELECT id FROM suppliers WHERE id = 3').all()
  console.log(
    `  Supplier 3 (probe cleanup): Neon rows=${supNeon.rows.length}, Local rows=${supLocal.length} ${supNeon.rows.length === supLocal.length ? '✓' : '✗'}`
  )

  // Tables 42/49-56 updated at 04:14-04:15 — compare status + revision columns
  const tablesNeon = await pool.query('SELECT id, status FROM tables WHERE id IN (42,49,50,51,52,53,54,55,56) ORDER BY id')
  const tablesLocal = local.query('SELECT id, status FROM tables WHERE id IN (42,49,50,51,52,53,54,55,56) ORDER BY id').all()
  const neonMap = new Map(tablesNeon.rows.map((r: any) => [Number(r.id), r.status]))
  let tableOk = true
  for (const t of tablesLocal as any[]) {
    if (neonMap.get(Number(t.id)) !== t.status) {
      tableOk = false
      console.log(`    ✗ table ${t.id}: Neon=${neonMap.get(Number(t.id))} Local=${t.status}`)
    }
  }
  console.log(
    `  Tables 42/49-56 (04:14 updates): ${tableOk ? '✓ all statuses identical' : '✗ status mismatch'}`
  )

  // Open order 2187 still open both sides?
  const orderNeon = await pool.query('SELECT id, status, total_amount, table_id FROM orders WHERE id IN (2186,2187) ORDER BY id')
  const orderLocal = local.query('SELECT id, status, total_amount, table_id FROM orders WHERE id IN (2186,2187) ORDER BY id').all()
  console.log(`  Orders Neon: ${JSON.stringify(orderNeon.rows.map((r: any) => [r.id, r.status, Number(r.total_amount)]))}`)
  console.log(`  Orders Local: ${JSON.stringify((orderLocal as any[]).map((r) => [r.id, r.status, r.total_amount]))}`)

  // Audit tail parity (last 5 ids)
  const auditNeon = await pool.query('SELECT id, action FROM audit_logs ORDER BY id DESC LIMIT 5')
  const auditLocal = local.query('SELECT id, action FROM audit_logs ORDER BY id DESC LIMIT 5').all()
  const neonAuditIds = auditNeon.rows.map((r: any) => `${r.id}:${r.action}`)
  const localAuditIds = (auditLocal as any[]).map((r) => `${r.id}:${r.action}`)
  console.log(`  Audit tail Neon : ${neonAuditIds.join(' | ')}`)
  console.log(`  Audit tail Local: ${localAuditIds.join(' | ')}`)
  console.log(
    JSON.stringify(neonAuditIds) === JSON.stringify(localAuditIds)
      ? '  ✓ audit tails identical'
      : '  ✗ audit tails differ (check Turso self-reference lag or new cloud writes)'
  )

  // ── 4) Devices enrolled on the cloud (hub health inputs) ──
  const devices = await pool.query('SELECT * FROM hybrid_devices ORDER BY 1')
  console.log('\n── Enrolled devices on Neon ──')
  for (const d of devices.rows) {
    const cols = Object.keys(d)
    const name = d.name || d.device_name || d.id
    console.log(`  ${JSON.stringify({ ...d, [cols.find((c) => c.includes('key')) || 'x']: undefined })}`)
  }

  await pool.end()
  local.close()
  console.log('\n=== END CLOUD CHECK ===')
}

main().catch(async (e) => {
  console.error('FAILED:', e)
  await pool.end().catch(() => {})
  process.exit(1)
})
