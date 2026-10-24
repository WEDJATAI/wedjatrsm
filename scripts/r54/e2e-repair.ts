// r54 — E2E zero-residue cleanup + cross-plane divergence repair.
//
// CONTEXT (found during the r54 guided-checkout E2E):
//   · My E2E (order 2209) left the standard probe residue: order + item +
//     payments 291/292 + audits 6016-6020 on BOTH planes. Cleaned per the
//     r47 discipline (stream cleanup + hard deletes + supersede above
//     watermarks).
//   · Forensics exposed an OLDER divergence left by the previous session:
//     the cloud (Neon, authoritative — real production writes on the
//     Vercel deployment) has data the local terminal is missing because
//     the local DB was restored to the r51 recovery point at 20:14
//     (documented in r52) and the re-pull hit FK gaps:
//       - users 17 (ا. رمضان) + 18 (Mina) — cloud-native accounts
//       - user 12 (مينا) soft-deleted on the cloud (pin scrubbed) — local
//         still active with a pin that now collides with user 18
//       - order 2201 (dine-in 3496.50, table 48, waiter 18) + items
//         2581-2591 + its payment 291 (3496.50, tendered 3500, change 3.5)
//       - inventory transactions 771-787 (the payment's stock consumption)
//       - attendance 21 (Mina's check-in)
//   · Ghost payments 288/289 (3693.69 ×2) orphaned on BOTH planes, pointing
//     at the recycled order id 2203 (now a cancelled 25.20 takeaway) —
//     phantom money in every financial report. Deleted both planes.
//   · My E2E payment 291 collided with the cloud's payment 291 (same
//     autoincrement slot on two planes): on the cloud my create/update
//     were correctly ACK-but-NO-OP'd (the p20 stale protection — the
//     cloud's payment 291 for order 2201 was never harmed), but the cloud
//     never received my +25.20 row for order 2209. Resolution: delete my
//     local 291 (E2E residue), mirror the cloud's authoritative 291.
//
// PHASES
//   A — local E2E cleanup (SQLite direct): outbox events, rows, audits
//   B — Neon surgery (pg transaction): stream rows, data rows, ghost
//       payments, supersede events above watermarks (r47 pattern)
//   C — local mirror of cloud-authoritative rows (SQLite direct)
//   D — engine heal reset: failed in-events → attempts=0 so the next
//       pull cycle retries immediately (the apply path upserts; with the
//       parents present the FK gaps heal — the designed self-healing)
import { Pool } from 'pg'
import { createHash, randomUUID } from 'crypto'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'fs'

const env = Object.fromEntries(
  readFileSync('.env.deploy-local', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()] }),
)

const log = (msg: string) => console.log(`[r54-repair] ${msg}`)
let failed = 0
const ok = (cond: boolean, label: string) => {
  console.log(`  ${cond ? '✓' : '✗ FAIL'} — ${label}`)
  if (!cond) failed++
}

async function main() {
  const local = new Database('/home/z/my-project/db/custom.db')
  const pool = new Pool({ connectionString: env.NEON_DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 2 })

  // ══════════ PHASE A — local E2E cleanup ══════════
  log('PHASE A — local E2E residue cleanup (order 2209 cluster)')
  local.transaction(() => {
    // A1. outbox events (my E2E pushes — incl. the 3 still-pending tail)
    const ev = local.query(
      `DELETE FROM hybrid_events WHERE direction='out' AND (
        (entity='Order' AND entityId='2209') OR
        (entity='OrderItem' AND entityId='2610') OR
        (entity='Payment' AND entityId IN ('291','292') AND CAST(json_extract(payload,'$.orderId') AS INTEGER)=2209) OR
        (entity='AuditLog' AND entityId IN ('6016','6017','6018','6019','6020'))
      )`).run()
    log(`  A1 outbox events deleted: ${ev.changes}`)
    // A2. data rows
    const p = local.query(`DELETE FROM payments WHERE (id IN (291,292) AND order_id=2209) OR id IN (288,289)`).run()
    const it = local.query(`DELETE FROM order_items WHERE id=2610`).run()
    const o = local.query(`DELETE FROM orders WHERE id=2209`).run()
    const a = local.query(`DELETE FROM audit_logs WHERE entity='order' AND entity_id=2209`).run()
    log(`  A2 rows deleted: payments=${p.changes} items=${it.changes} order=${o.changes} audits=${a.changes}`)
  })()

  // ══════════ PHASE B — Neon surgery ══════════
  log('PHASE B — Neon surgery (single transaction)')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // B1. stray sweep: any of my E2E pushes that drained after 13562
    // (payload is TEXT on Neon — match the serialized key, no ->> operator)
    const stray = await client.query(
      `DELETE FROM hybrid_events WHERE direction='in' AND id > 13562 AND (
        (entity='Order' AND "entityId"='2209') OR
        (entity='OrderItem' AND "entityId"='2610') OR
        (entity='Payment' AND "entityId" IN ('291','292') AND payload LIKE '%"orderId":2209%') OR
        (entity='AuditLog' AND "entityId" IN ('6016','6017','6018','6019','6020'))
      ) RETURNING id`)
    log(`  B1 stray drained events deleted: ${stray.rowCount}`)
    // B2. my E2E stream rows + ghost-payment stream rows
    const delIds = [13548, 13549, 13550, 13551, 13552, 13553, 13554, 13555, 13556, 13557, 13558, 13559, 13560, 13561, 13562, 13322, 13323]
    const del = await client.query(`DELETE FROM hybrid_events WHERE id = ANY($1) RETURNING id`, [delIds])
    log(`  B2 stream rows deleted: ${del.rowCount} (expect ${delIds.length})`)
    // B3. data rows: my E2E cluster + ghost payments
    const dp = await client.query(`DELETE FROM payments WHERE id IN (288,289,292) OR (id=291 AND order_id=2209) RETURNING id`)
    const di = await client.query(`DELETE FROM order_items WHERE id=2610 RETURNING id`)
    const dor = await client.query(`DELETE FROM orders WHERE id=2209 RETURNING id`)
    const da = await client.query(`DELETE FROM audit_logs WHERE entity='order' AND entity_id=2209 RETURNING id`)
    log(`  B3 rows deleted: payments=${dp.rowCount} (expect 3: 288,289,292) items=${di.rowCount} order=${dor.rowCount} audits=${da.rowCount} (expect 5)`)
    // B4. supersede events — revisions ABOVE every watermark we have seen
    const emit = async (entity: string, entityId: string, operation: string, revision: number, payload: object) => {
      const body = JSON.stringify(payload)
      await client.query(
        `INSERT INTO hybrid_events ("eventId","deviceId","entity","entityId","operation","revision","payloadHash","payload","direction","status","attempts","createdAt","updatedAt")
         VALUES ($1,'unbound',$2,$3,$4,$5,$6,$7,'out','pending',0,now(),now())`,
        [randomUUID(), entity, entityId, operation, revision, createHash('sha256').update(body).digest('hex'), body],
      )
    }
    await emit('Order', '2209', 'delete', 7, { id: 2209 })
    await emit('OrderItem', '2610', 'delete', 2, { id: 2610 })
    await emit('Payment', '292', 'delete', 2, { id: 292 })
    await emit('Payment', '288', 'delete', 2, { id: 288 })
    await emit('Payment', '289', 'delete', 2, { id: 289 })
    // Payment/291: NOT a delete — a supersede UPDATE with the authoritative
    // order-2201 payload. A delete here would destroy the cloud's legitimate
    // payment 291 on every device that pulled it; the update heals any device
    // that instead received MY E2E 291 (the id-collision victim) by
    // overwriting it with the authoritative row.
    await emit('Payment', '291', 'update', 5, {
      id: 291, orderId: 2201, method: 'cash', amount: 3496.5, tip: 0,
      reference: 'CASH-20261014-143452-00C', amountTendered: 3500, changeGiven: 3.5,
      createdAt: '2026-10-14T14:34:52.554Z',
    })
    for (const id of [6016, 6017, 6018, 6019, 6020]) await emit('AuditLog', String(id), 'delete', 2, { id })
    log('  B4 supersede events emitted: Order/2209@7, Item/2610@2, Payment/292@2, Payment/288@2, Payment/289@2, Payment/291@update@5 (authoritative), AuditLog/6016-6020@2')
    await client.query('COMMIT')
    log('  B committed')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }

  // ══════════ PHASE C — local mirror of cloud-authoritative rows ══════════
  log('PHASE C — local mirror (SQLite direct, byte-mirror of the cloud rows)')
  local.transaction(() => {
    // C1. users
    local.query(`INSERT OR REPLACE INTO users (id,email,password_hash,name,role,role_id,pin,active,is_super_admin,hourly_rate,created_at) VALUES
      (17,'aaa@bbb.com','$2b$10$gJaRP5D9XENbevXKkpqpS.qjMGDJ655b8Hr5Dc.zVyb4NOT1KDt4.','ا. رمضان','custom',3,'654321',1,0,NULL,'2026-10-13T12:33:45.770Z'),
      (18,'123@123.com','$2b$10$SryDVAKR1nivohgwlP7G8.KO0yx0dQekHk9hCz6W1V2Fj9HpzpdmS','Mina','custom',2,'246810',1,0,NULL,'2026-10-14T08:24:26.383Z')`).run()
    // C2. user 12 — mirror the cloud's soft-delete (pin scrubbed, email tombstoned)
    local.query(`UPDATE users SET active=0, pin=NULL, email='deleted.12.1791966100@deleted.rsm',
      password_hash='$2b$10$Zr4CDbEYP7WY.lKkPSZsaObrlKL8i.esBm3CliDLsYzFMDMY7SpFK' WHERE id=12`).run()
    // C3. order 2201 + items
    local.query(`INSERT OR REPLACE INTO orders (id,table_id,user_id,status,order_type,delivery_phone,delivery_address,customer_id,points_earned,points_redeemed,external_ref,guests,subtotal_amount,total_amount,discount_amount,tax_amount,service_tax_amount,discount_reason,client_name,extra_table_ids,origin_device_id,check_issued_by_person_id,check_issued_at,created_at,closed_at,updated_at) VALUES
      (2201,48,18,'paid','dinein',NULL,NULL,NULL,0,0,NULL,4,2775,3496.5,0,388.5,333,NULL,NULL,NULL,NULL,NULL,NULL,'2026-10-14T08:26:51.411Z','2026-10-14T14:34:52.596Z','2026-10-14T14:34:52.598Z')`).run()
    local.query(`INSERT OR REPLACE INTO order_items (id,order_id,product_id,quantity,unit_price,notes,course,status,selected_modifiers,created_at) VALUES
      (2581,2201,314,1,180,NULL,'main','ready',NULL,'2026-10-14T08:26:51.411Z'),
      (2582,2201,313,1,180,NULL,'main','ready',NULL,'2026-10-14T08:26:51.411Z'),
      (2583,2201,308,1,145,NULL,'main','ready',NULL,'2026-10-14T08:26:51.411Z'),
      (2584,2201,307,1,125,NULL,'main','served',NULL,'2026-10-14T08:26:51.411Z'),
      (2585,2201,317,4,20,NULL,'main','ready',NULL,'2026-10-14T08:26:51.411Z'),
      (2586,2201,170,3,55,NULL,'drink','ready',NULL,'2026-10-14T08:26:51.411Z'),
      (2587,2201,169,1,45,NULL,'drink','ready','[{"id":39,"name":"Single","nameAr":"سنجل","priceDelta":0}]','2026-10-14T08:26:51.411Z'),
      (2588,2201,128,2,450,NULL,'main','ready',NULL,'2026-10-14T08:26:51.411Z'),
      (2589,2201,117,1,450,NULL,'main','ready',NULL,'2026-10-14T08:26:51.411Z'),
      (2590,2201,118,1,425,NULL,'main','ready',NULL,'2026-10-14T08:26:51.411Z'),
      (2591,2201,218,4,20,NULL,'drink','ready','[{"id":45,"name":"Small","nameAr":"صغيرة","priceDelta":0}]','2026-10-14T08:27:26.840Z')`).run()
    // C4. the cloud's payment 291 (authoritative — order 2201)
    local.query(`INSERT OR REPLACE INTO payments (id,order_id,method,amount,tip,reference,amount_tendered,change_given,created_at) VALUES
      (291,2201,'cash',3496.5,0,'CASH-20261014-143452-00C',3500,3.5,'2026-10-14T14:34:52.554Z')`).run()
    // C5. attendance 21 (Mina's check-in)
    local.query(`INSERT OR REPLACE INTO attendance (id,user_id,check_in_at,check_out_at,late_minutes,created_at) VALUES
      (21,18,'2026-10-14T08:24:59.814Z',NULL,0,'2026-10-14T08:24:59.821Z')`).run()
    // C6. inventory transactions 771-787 (order 2201's stock consumption)
    const inv: Array<[number, number, number, string, number, string]> = [
      [771, 13, -0.008, 'sale', 2201, '2026-10-14T14:34:52.677Z'], [772, 15, -0.4, 'sale', 2201, '2026-10-14T14:34:52.701Z'],
      [773, 16, -0.08, 'sale', 2201, '2026-10-14T14:34:52.725Z'], [774, 242, -0.16, 'sale', 2201, '2026-10-14T14:34:52.749Z'],
      [775, 243, -0.1, 'sale', 2201, '2026-10-14T14:34:52.773Z'], [776, 231, -0.04, 'sale', 2201, '2026-10-14T14:34:52.796Z'],
      [777, 303, -0.008, 'sale', 2201, '2026-10-14T14:34:52.819Z'], [778, 2, -0.25, 'sale', 2201, '2026-10-14T14:34:52.842Z'],
      [779, 6, -0.15, 'sale', 2201, '2026-10-14T14:34:52.864Z'], [780, 231, -0.02, 'sale', 2201, '2026-10-14T14:34:52.888Z'],
      [781, 303, -0.004, 'sale', 2201, '2026-10-14T14:34:52.914Z'], [782, 250, -0.05, 'sale', 2201, '2026-10-14T14:34:52.943Z'],
      [783, 2, -0.2, 'sale', 2201, '2026-10-14T14:34:52.968Z'], [784, 8, -0.08, 'sale', 2201, '2026-10-14T14:34:52.992Z'],
      [785, 5, -0.04, 'sale', 2201, '2026-10-14T14:34:53.028Z'], [786, 250, -0.08, 'sale', 2201, '2026-10-14T14:34:53.052Z'],
      [787, 231, -0.02, 'sale', 2201, '2026-10-14T14:34:53.076Z'],
    ]
    for (const [id, pid, qc, reason, oid, at] of inv) {
      local.query(`INSERT OR REPLACE INTO inventory_transactions (id,product_id,quantity_change,reason,order_id,created_at) VALUES (?,?,?,?,?,?)`).run(id, pid, qc, reason, oid, at)
    }
    log('  C mirrored: users 17/18, user-12 soft-delete, order 2201, items 2581-2591, payment 291 (cloud), attendance 21, inventory 771-787')
  })()

  // ══════════ PHASE D — engine heal reset ══════════
  log('PHASE D — engine heal reset (failed in-events → retry immediately)')
  const reset = local.query(`UPDATE hybrid_events SET attempts=0, nextAttemptAt=NULL WHERE direction='in' AND status='failed'`).run()
  log(`  D1 failed in-events reset: ${reset.changes}`)

  // ══════════ verification ══════════
  log('VERIFY (local):')
  ok((local.query(`SELECT COUNT(*) c FROM orders WHERE id=2209`).get() as any).c === 0, 'order 2209 gone')
  ok((local.query(`SELECT COUNT(*) c FROM payments WHERE order_id=2209`).get() as any).c === 0, 'payments for 2209 gone')
  ok((local.query(`SELECT COUNT(*) c FROM audit_logs WHERE entity='order' AND entity_id=2209`).get() as any).c === 0, 'audits for 2209 gone')
  ok((local.query(`SELECT COUNT(*) c FROM payments WHERE id IN (288,289)`).get() as any).c === 0, 'ghost payments 288/289 gone')
  ok(local.query(`SELECT id FROM orders WHERE id=2201`).get() !== null, 'order 2201 present')
  ok((local.query(`SELECT COUNT(*) c FROM order_items WHERE order_id=2201`).get() as any).c === 11, 'order 2201 has 11 items')
  ok((local.query(`SELECT order_id FROM payments WHERE id=291`).get() as any)?.order_id === 2201, 'payment 291 = order 2201 (cloud authoritative)')
  ok((local.query(`SELECT COUNT(*) c FROM users WHERE id IN (17,18)`).get() as any).c === 2, 'users 17/18 present')
  ok((local.query(`SELECT active FROM users WHERE id=12`).get() as any)?.active === 0, 'user 12 soft-deleted (mirrors cloud)')
  ok((local.query(`SELECT COUNT(*) c FROM attendance WHERE id=21`).get() as any).c === 1, 'attendance 21 present')
  ok((local.query(`SELECT COUNT(*) c FROM inventory_transactions WHERE id BETWEEN 771 AND 787`).get() as any).c === 17, 'inventory 771-787 present')
  const fk = local.query(`PRAGMA foreign_key_check`).all()
  ok(fk.length === 0, `foreign_key_check clean (${fk.length} violations)`)

  log('VERIFY (cloud):')
  const c1 = await pool.query('SELECT COUNT(*) c FROM orders WHERE id=2209')
  ok(Number(c1.rows[0].c) === 0, 'cloud order 2209 gone')
  const c2 = await pool.query('SELECT COUNT(*) c FROM payments WHERE id IN (288,289,292)')
  ok(Number(c2.rows[0].c) === 0, 'cloud payments 288/289/292 gone')
  const c3 = await pool.query(`SELECT COUNT(*) c FROM audit_logs WHERE entity='order' AND entity_id=2209`)
  ok(Number(c3.rows[0].c) === 0, 'cloud audits for 2209 gone')
  const c4 = await pool.query(`SELECT COUNT(*) c FROM hybrid_events WHERE ((entity='Order' AND "entityId"='2209') OR (entity='OrderItem' AND "entityId"='2610') OR (entity='Payment' AND "entityId" IN ('288','289','292')) OR (entity='AuditLog' AND "entityId" IN ('6016','6017','6018','6019','6020'))) AND NOT ("deviceId"='unbound' AND revision >= 2 AND operation IN ('delete','update'))`)
  ok(Number(c4.rows[0].c) === 0, `cloud stream clean of E2E/ghost rows (${c4.rows[0].c} left)`)

  local.close()
  await pool.end()
  console.log(failed === 0 ? '\n[r54-repair] ALL CHECKS PASS' : `\n[r54-repair] ${failed} CHECK(S) FAILED`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
