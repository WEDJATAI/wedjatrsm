import { getTursoClient } from '../../src/lib/turso'
const turso = getTursoClient()
for (const t of ['customers', 'orders', 'payments', 'products', 'audit_logs', 'order_items', 'categories', 'inventory_transactions']) {
  const r = await turso.execute(`SELECT count(*) n FROM ${t}`)
  console.log('TURSO', t, '=', JSON.stringify(r.rows[0]))
}
