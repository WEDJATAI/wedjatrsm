/**
 * r38 — collision-risk map: for every synced table, compare Neon sequence
 * position + row count vs local SQLite max(id) + row count. Any Neon seq
 * below local max(id) is a FUTURE cloud-create collision (overwrite risk).
 */
import { Pool } from 'pg'
import { neonPooledUrl } from '../lib/env-local'
import { db } from '../../src/lib/db'

const TABLES: Array<[string, string]> = [
  // [pg_table, prisma_model]
  ['customers', 'customer'],
  ['orders', 'order'],
  ['payments', 'payment'],
  ['products', 'product'],
  ['order_items', 'orderItem'],
  ['categories', 'category'],
  ['suppliers', 'supplier'],
  ['reservations', 'reservation'],
  ['restaurant_tables', 'restaurantTable'],
  ['floor_plans', 'floorPlan'],
  ['inventory_items', 'inventoryItem'],
  ['inventory_transactions', 'inventoryTransaction'],
  ['promotions', 'promotion'],
  ['purchase_orders', 'purchaseOrder'],
  ['stock_counts', 'stockCount'],
  ['waste_logs', 'wasteLog'],
  ['modifier_groups', 'modifierGroup'],
  ['people', 'person'],
  ['custom_roles', 'customRole'],
]

const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })

async function main() {
  console.log(
    'table'.padEnd(22),
    'localMax'.padStart(9),
    'localN'.padStart(7),
    'neonMax'.padStart(9),
    'neonN'.padStart(7),
    'neonSeq'.padStart(9),
    '  risk',
  )
  let risks = 0
  for (const [table, model] of TABLES) {
    try {
      const n = await pool.query(`SELECT COALESCE(MAX(id),0)::int mx, COUNT(*)::int c FROM ${table}`)
      const neonMax = n.rows[0].mx as number
      const neonN = n.rows[0].c as number
      let seq: number | null = null
      try {
        const s = await pool.query(`SELECT pg_get_serial_sequence('${table}','id') AS seqname`)
        const seqname = s.rows[0]?.seqname as string | null
        if (seqname) {
          const v = await pool.query(`SELECT last_value::int v FROM ${seqname}`)
          seq = v.rows[0]?.v ?? null
        }
      } catch {
        seq = null
      }
      // local max id via Prisma raw on SQLite
      const prismaModel = model as keyof typeof db
      const delegate = db[prismaModel] as unknown as { aggregate: (a: unknown) => Promise<{ _max: { id: number | null } }> }
      const agg = await delegate.aggregate({ _max: { id: true } })
      const localMax = agg._max.id ?? 0
      const localN = await (db[prismaModel] as unknown as { count: (a?: unknown) => Promise<number> }).count()
      const risk = seq !== null && seq < localMax ? `YES seq(${seq}) < localMax(${localMax})` : 'ok'
      if (risk !== 'ok') risks++
      console.log(
        table.padEnd(22),
        String(localMax).padStart(9),
        String(localN).padStart(7),
        String(neonMax).padStart(9),
        String(neonN).padStart(7),
        String(seq ?? '—').padStart(9),
        '  ' + risk,
      )
    } catch (e) {
      console.log(table.padEnd(22), 'ERROR:', (e as Error).message.slice(0, 70))
    }
  }
  console.log(risks === 0 ? '\nNo sequence-collision risks.' : `\n${risks} tables at collision risk.`)
  await pool.end()
  await db.$disconnect()
}

main().catch((e) => {
  console.error('FAIL:', e.message)
  process.exit(1)
})
