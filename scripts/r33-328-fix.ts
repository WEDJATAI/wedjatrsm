import { Pool } from 'pg'
import { neonPooledUrl } from './lib/env-local'
import { Database } from 'bun:sqlite'
async function main() {
  const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
  // does Neon have 328's payment?
  const pay = await pool.query(`SELECT id, order_id, amount FROM payments WHERE order_id = 328`)
  console.log('Neon payments for 328:', pay.rows.map((x: any) => `${x.id}/${x.amount}`).join(' ') || 'NONE')
  // stranded pending out-events overview
  const pend = await pool.query(`SELECT entity, COUNT(*)::int c, MIN(revision) minr, MAX(revision) maxr FROM hybrid_events WHERE direction='out' AND status='pending' GROUP BY entity ORDER BY c DESC`)
  console.log('Neon stranded pending out-events by entity:')
  for (const r of pend.rows) console.log('  ', r.entity, 'count=' + r.c, 'rev ' + r.minr + '-' + r.maxr)
  // surgical: converge 328 to the local paid row
  const db = new Database('/home/z/my-project/db/custom.db', { readonly: true })
  const l = db.prepare(`SELECT status, subtotal_amount, tax_amount, service_tax_amount, discount_amount, total_amount, closed_at, updated_at, points_earned, points_redeemed, check_issued_by_person_id, check_issued_at FROM orders WHERE id = 328`).get() as any
  console.log('local 328 row:', JSON.stringify(l).slice(0, 200))
  const upd = await pool.query(
    `UPDATE orders SET status=$1, subtotal_amount=$2, tax_amount=$3, service_tax_amount=$4, discount_amount=$5, total_amount=$6, closed_at=$7, updated_at=$8, points_earned=$9, points_redeemed=$10, check_issued_by_person_id=$11, check_issued_at=$12
     WHERE id = 328 RETURNING id, status, total_amount`,
    [l.status, l.subtotal_amount, l.tax_amount, l.service_tax_amount, l.discount_amount, l.total_amount,
     l.closed_at ? new Date(Number(l.closed_at)) : null, l.updated_at ? new Date(Number(l.updated_at)) : null,
     l.points_earned, l.points_redeemed, l.check_issued_by_person_id,
     l.check_issued_at ? new Date(Number(l.check_issued_at)) : null])
  console.log('S4 surgical update 328 →', JSON.stringify(upd.rows[0]))
  await pool.end()
}
main().then(() => process.exit(0)).catch(e => { console.error('ERR', e.message); process.exit(1) })
