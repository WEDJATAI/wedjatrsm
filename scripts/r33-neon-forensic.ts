import { Pool } from 'pg'
import { neonPooledUrl } from './lib/env-local'
async function main() {
  const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
  const o = await pool.query(`SELECT id, status, created_at, closed_at FROM orders WHERE id >= 1208 ORDER BY id`)
  console.log('Neon orders >= 1208:', o.rows.map((x: any) => `${x.id}/${x.status}`).join(' '))
  const ev = await pool.query(`SELECT id, entity, "entityId", operation, status, "createdAt" FROM hybrid_events WHERE operation='delete' ORDER BY id DESC LIMIT 10`)
  console.log('delete-op events:', ev.rows.length ? ev.rows.map((x: any) => `${x.id}:${x.entity}/${x.entityId}/${x.status}`).join(' ') : 'none')
  const au = await pool.query(`SELECT id, action, created_at FROM audit_logs ORDER BY id DESC LIMIT 12`)
  console.log('recent Neon audit:', au.rows.map((x: any) => `${x.id}:${x.action}@${new Date(Number(x.created_at)).toISOString().slice(0, 16)}`).join('\n  '))
  // when were the creates of 1211/1214/1215 applied on Neon?
  const t = await pool.query(`SELECT id, "entityId", status, "createdAt", "updatedAt" FROM hybrid_events WHERE entity='Order' AND "entityId" IN ('1211','1214','1215') AND operation='create'`)
  for (const r of t.rows) console.log('create', r.entityId, r.status, 'created', new Date(Number(r.createdAt)).toISOString(), 'updated', new Date(Number(r.updatedAt)).toISOString())
  // do the order_items / payments exist on neon for these?
  const it = await pool.query(`SELECT order_id, COUNT(*)::int c FROM order_items WHERE order_id IN (1211,1214,1215) GROUP BY order_id`)
  console.log('order_items on Neon:', it.rows.map((x: any) => `${x.order_id}:${x.c}`).join(' ') || 'none')
  const p = await pool.query(`SELECT order_id, COUNT(*)::int c, SUM(amount)::float s FROM payments WHERE order_id IN (1211,1214,1215,1216) GROUP BY order_id`)
  console.log('payments on Neon:', p.rows.map((x: any) => `${x.order_id}:${x.c}(sum ${x.s})`).join(' ') || 'none')
  await pool.end()
}
main().then(() => process.exit(0)).catch(e => { console.error('ERR', e.message); process.exit(1) })
