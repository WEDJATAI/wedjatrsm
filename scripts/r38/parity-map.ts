/**
 * r38 — comprehensive parity map: row counts + max(id) for EVERY hybrid-registry
 * table, local SQLite vs Neon Postgres. The complete divergence inventory.
 */
import { Pool } from 'pg'
import { neonPooledUrl } from '../lib/env-local'
import { db } from '../../src/lib/db'

// [pg_table, prisma_model]
const TABLES: Array<[string, string]> = [
  ['customers', 'customer'],
  ['orders', 'order'],
  ['order_items', 'orderItem'],
  ['payments', 'payment'],
  ['products', 'product'],
  ['categories', 'category'],
  ['suppliers', 'supplier'],
  ['reservations', 'reservation'],
  ['tables', 'restaurantTable'],
  ['floor_plans', 'floorPlan'],
  ['inventory_transactions', 'inventoryTransaction'],
  ['promotions', 'promotion'],
  ['purchase_orders', 'purchaseOrder'],
  ['purchase_order_items', 'purchaseOrderItem'],
  ['stock_counts', 'stockCount'],
  ['stock_count_lines', 'stockCountLine'],
  ['waste_logs', 'wasteLog'],
  ['modifier_groups', 'modifierGroup'],
  ['modifiers', 'modifier'],
  ['recipe_components', 'recipeComponent'],
  ['persons', 'person'],
  ['roles', 'customRole'],
  ['attendance', 'attendance'],
  ['shifts', 'shift'],
  ['cash_drawer_entries', 'cashDrawerEntry'],
  ['cash_drawer_sessions', 'cashDrawerSession'],
  ['audit_logs', 'auditLog'],
]

const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })

async function main() {
  console.log('table'.padEnd(22), 'localN'.padStart(7), 'neonN'.padStart(7), 'localMax'.padStart(9), 'neonMax'.padStart(9), '  verdict')
  for (const [table, model] of TABLES) {
    try {
      const n = await pool.query(`SELECT COALESCE(MAX(id),0)::int mx, COUNT(*)::int c FROM ${table}`)
      const delegate = db[model as keyof typeof db] as unknown as {
        aggregate: (a: unknown) => Promise<{ _max: { id: number | null } }>
        count: (a?: unknown) => Promise<number>
      }
      const agg = await delegate.aggregate({ _max: { id: true } })
      const localN = await delegate.count()
      const neonN = n.rows[0].c as number
      const neonMax = n.rows[0].mx as number
      const localMax = agg._max.id ?? 0
      const verdict = localN === neonN && localMax === neonMax ? '✓ parity' : `DIVERGE (Δn=${localN - neonN})`
      console.log(table.padEnd(22), String(localN).padStart(7), String(neonN).padStart(7), String(localMax).padStart(9), String(neonMax).padStart(9), '  ' + verdict)
    } catch (e) {
      console.log(table.padEnd(22), 'ERROR:', (e as Error).message.slice(0, 60))
    }
  }
  await pool.end()
  await db.$disconnect()
}

main().catch((e) => {
  console.error('FAIL:', e.message)
  process.exit(1)
})
