/**
 * r39 — Neon surgical repairs (direct, id-preserving; same class as the r38
 * parity repair, documented in the worklog):
 *
 *  1. ATTENDANCE ID-1 COLLISION (found by the r39 audit): local #1 is Omar
 *     Khaled's shift (u2, Sep 29 → Oct 2, checked out) while Neon #1 is a
 *     cloud-side check-in by "Cloud Demo" (u10, Sep 23, never closed). Both
 *     sides allocated id 1 independently in the pre-r38 era. Each side keeps
 *     its own row and never receives the other's → the aggregate history is
 *     split across DBs. Repair: re-id the Neon u10 row 1 → 14 (above current
 *     max 13), insert LOCAL's u2 row at id 1 on Neon, insert NEON's u10 row
 *     at id 14 LOCALLY (both users exist on both sides — registries are
 *     identical). No data is deleted; both rows survive on both sides.
 *
 *  2. AUDIT BACKFILL Δ3 (4662–4664): rows created between the r38 backfill
 *     and the r39 logAudit emit fix have no outbox events (the old code never
 *     emitted AuditLog). Insert them into Neon id-preserving + setval.
 */
import { Pool } from 'pg'
import { neonPooledUrl } from '../lib/env-local'
import { db } from '../../src/lib/db'

const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })

async function main(): Promise<void> {
  // ── sanity pre-checks ───────────────────────────────────────────────
  const neonAtt1 = await pool.query('select id, user_id from attendance where id = 1')
  if (neonAtt1.rows.length === 0) throw new Error('Neon attendance #1 missing — abort')
  if (neonAtt1.rows[0].user_id !== 10) throw new Error(`Neon attendance #1 is u${neonAtt1.rows[0].user_id}, expected u10 — abort (state changed?)`)
  const neonMax = await pool.query('select max(id)::int m from attendance')
  const newId = Math.max(14, (neonMax.rows[0].m ?? 0) + 1)
  console.log(`[repair] Neon attendance max=${neonMax.rows[0].m} → re-iding cloud u10 row to ${newId}`)

  const localAtt1 = await db.attendance.findUnique({ where: { id: 1 } })
  if (!localAtt1) throw new Error('local attendance #1 missing — abort')
  if (localAtt1.userId !== 2) throw new Error(`local attendance #1 is u${localAtt1.userId}, expected u2 — abort`)

  // ── 1a. Neon: re-id the cloud u10 row 1 → newId ──────────────────────
  await pool.query('update attendance set id = $1 where id = 1', [newId])
  console.log(`[repair] Neon: cloud u10 row re-ided 1 → ${newId}`)

  // ── 1b. Neon: insert LOCAL's u2 row at id 1 ──────────────────────────
  await pool.query(
    `insert into attendance (id, user_id, check_in_at, check_out_at, late_minutes, created_at)
     values (1, $1, $2, $3, $4, $5)`,
    [localAtt1.userId, localAtt1.checkInAt, localAtt1.checkOutAt, localAtt1.lateMinutes, localAtt1.createdAt],
  )
  console.log('[repair] Neon: local u2 row inserted at id 1')

  // ── 1c. Neon: keep the sequence above max(id) ────────────────────────
  await pool.query(`SELECT setval(pg_get_serial_sequence('attendance','id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM attendance), ${newId}), true)`)

  // ── 1d. LOCAL: insert NEON's u10 row at newId ────────────────────────
  const neonRow = await pool.query('select * from attendance where id = $1', [newId])
  const r = neonRow.rows[0]
  const dupLocally = await db.attendance.findUnique({ where: { id: newId } })
  if (!dupLocally) {
    await db.attendance.create({
      data: {
        id: newId,
        userId: r.user_id,
        checkInAt: new Date(r.check_in_at),
        checkOutAt: r.check_out_at === null ? null : new Date(r.check_out_at),
        lateMinutes: r.late_minutes,
        createdAt: new Date(r.created_at),
      },
    })
    console.log(`[repair] local: cloud u10 row inserted at id ${newId}`)
  } else {
    console.log(`[repair] local: id ${newId} already present — skip`)
  }

  // ── 2. audit backfill 4662–4664 (only rows Neon still misses) ───────
  const neonMaxAudit = await pool.query('select max(id)::int m from audit_logs')
  const neonMaxId = neonMaxAudit.rows[0].m ?? 0
  const missing = await db.auditLog.findMany({ where: { id: { lte: 4664, gt: neonMaxId } }, orderBy: { id: 'asc' } })
  console.log(`[repair] audit backfill: Neon max=${neonMaxId}, local rows to insert: ${missing.map((a) => a.id).join(',') || 'none'}`)
  for (const a of missing) {
    await pool.query(
      `insert into audit_logs (id, user_id, user_name, person_id, person_name, action, entity, entity_id, details, created_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (id) do nothing`,
      [a.id, a.userId, a.userName, a.personId, a.personName, a.action, a.entity, a.entityId, a.details, a.createdAt],
    )
  }
  if (missing.length > 0) {
    await pool.query(`SELECT setval(pg_get_serial_sequence('audit_logs','id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM audit_logs), ${missing[missing.length - 1].id}), true)`)
  }

  // ── verify ──────────────────────────────────────────────────────────
  const v1 = await pool.query('select id, user_id, check_out_at is not null as closed from attendance order by id')
  console.log('[verify] Neon attendance:', v1.rows.map((x: { id: number; user_id: number; closed: boolean }) => `#${x.id}(u${x.user_id}${x.closed ? '✓' : '·'})`).join(' '))
  const v2 = await db.attendance.findMany({ orderBy: { id: 'asc' }, select: { id: true, userId: true, checkOutAt: true } })
  console.log('[verify] local attendance:', v2.map((x) => `#${x.id}(u${x.userId}${x.checkOutAt ? '✓' : '·'})`).join(' '))
  const v3 = await pool.query('select count(*)::int c, max(id)::int m from audit_logs')
  console.log(`[verify] Neon audit: count=${v3.rows[0].c} max=${v3.rows[0].m}`)
  await pool.end()
  await db.$disconnect()
}

main().catch(async (err) => {
  console.error('[repair] FAILED:', err)
  await pool.end().catch(() => undefined)
  await db.$disconnect().catch(() => undefined)
  process.exit(1)
})
