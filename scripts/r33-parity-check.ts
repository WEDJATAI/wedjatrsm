import { Pool } from 'pg'
import { neonPooledUrl } from '/home/z/my-project/scripts/lib/env-local'
import { Database } from 'bun:sqlite'

async function main() {
  // Neon counts
  const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
  const neonOrders = await pool.query("SELECT status, COUNT(*)::int c FROM orders GROUP BY status ORDER BY status")
  const neonPays = await pool.query("SELECT COUNT(*)::int c FROM payments")
  const neonUsers = await pool.query("SELECT COUNT(*)::int c FROM users")
  const neonProducts = await pool.query("SELECT COUNT(*)::int c FROM products")
  const neonEvents = await pool.query("SELECT COUNT(*)::int c FROM hybrid_events")
  await pool.end()

  // Local counts
  const db = new Database('/home/z/my-project/db/custom.db', { readonly: true })
  const localOrders: any[] = db.prepare('SELECT status, COUNT(*) c FROM orders GROUP BY status ORDER BY status').all()
  const localPays = (db.prepare('SELECT COUNT(*) c FROM payments').get() as { c: number }).c
  const localUsers = (db.prepare('SELECT COUNT(*) c FROM users').get() as { c: number }).c
  const localProducts = (db.prepare('SELECT COUNT(*) c FROM products').get() as { c: number }).c
  const localEvents = (db.prepare('SELECT COUNT(*) c FROM hybrid_events').get() as { c: number }).c

  const fmt = (rows: any[]) => rows.map((r: any) => `${r.status}:${r.c}`).join(' ')
  console.log('orders  — local:', fmt(localOrders))
  console.log('orders  — neon :', fmt(neonOrders.rows))
  console.log(`payments — local: ${localPays} | neon: ${neonPays.rows[0].c}`)
  console.log(`users    — local: ${localUsers} | neon: ${neonUsers.rows[0].c}`)
  console.log(`products — local: ${localProducts} | neon: ${neonProducts.rows[0].c}`)
  console.log(`hybrid_events — local: ${localEvents} | neon: ${neonEvents.rows[0].c}`)

  // Row-level id check for orders
  const neonIds = await (async () => { const p = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 1 }); const r = await p.query('SELECT id FROM orders ORDER BY id'); await p.end(); return new Set(r.rows.map((x: any) => Number(x.id))) })()
  const localIds = new Set(db.prepare('SELECT id FROM orders').all().map((x: any) => x.id))
  const onlyLocal = [...localIds].filter(id => !neonIds.has(id))
  const onlyNeon = [...neonIds].filter(id => !localIds.has(id))
  console.log('order-id diff — only-local:', onlyLocal.length ? onlyLocal.join(',') : 'none', '| only-neon:', onlyNeon.length ? onlyNeon.join(',') : 'none')
}
main().then(() => process.exit(0)).catch(e => { console.error('ERR', e.message); process.exit(1) })
