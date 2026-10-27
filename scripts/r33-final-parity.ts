import { Pool } from 'pg'
import { neonPooledUrl } from './lib/env-local'
import { Database } from 'bun:sqlite'
async function main() {
  const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
  const neonOrders = await pool.query('SELECT id, status FROM orders ORDER BY id')
  const neonPays = await pool.query('SELECT id, order_id, amount FROM payments ORDER BY id')
  const neonProds = await pool.query('SELECT id FROM products ORDER BY id')
  const neonItems = await pool.query('SELECT id, order_id FROM order_items ORDER BY id')
  await pool.end()
  const db = new Database('/home/z/my-project/db/custom.db', { readonly: true })
  const L = {
    orders: db.prepare('SELECT id, status FROM orders ORDER BY id').all() as any[],
    pays: db.prepare('SELECT id, order_id, amount FROM payments ORDER BY id').all() as any[],
    prods: db.prepare('SELECT id FROM products ORDER BY id').all() as any[],
    items: db.prepare('SELECT id, order_id FROM order_items ORDER BY id').all() as any[],
  }
  const cmp = (name: string, a: any[], b: any[], key: (r: any) => string) => {
    const am = new Map(a.map(r => [key(r), r])), bm = new Map(b.map(r => [key(r), r]))
    const diffs: string[] = []
    for (const k of new Set([...am.keys(), ...bm.keys()])) {
      const x = am.get(k), y = bm.get(k)
      if (!x) diffs.push(`${k}: only-neon`)
      else if (!y) diffs.push(`${k}: only-local`)
      else if (JSON.stringify(x) !== JSON.stringify(y)) diffs.push(`${k}: local=${JSON.stringify(x)} neon=${JSON.stringify(y)}`)
    }
    console.log(`${name}: local=${a.length} neon=${b.length} ${diffs.length === 0 ? '✓ IDENTICAL' : 'DIFFS:'}`)
    for (const d of diffs) console.log('   ', d)
    return diffs.length
  }
  let bad = 0
  bad += cmp('orders', L.orders, neonOrders.rows, r => String(r.id))
  bad += cmp('payments', L.pays, neonPays.rows, r => String(r.id))
  bad += cmp('products', L.prods, neonProds.rows, r => String(r.id))
  bad += cmp('order_items', L.items, neonItems.rows, r => String(r.id))
  console.log(bad === 0 ? '\n══ FULL PARITY: local == Neon on all four tables ══' : `\n══ ${bad} tables still diverge ══`)
}
main().then(() => process.exit(0)).catch(e => { console.error('ERR', e.message); process.exit(1) })
