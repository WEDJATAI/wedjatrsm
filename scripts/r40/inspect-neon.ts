import { Pool } from 'pg'
import { neonPooledUrl } from '../lib/env-local'
const pool = new Pool({ connectionString: neonPooledUrl() })
const pg = { $queryRawUnsafe: async (sql: string) => (await pool.query(sql)).rows, $disconnect: () => pool.end() }

async function main() {
  const q = async (sql: string) => (await pg.$queryRawUnsafe(sql)) as any[]
  console.log('=== NEON USERS ===')
  for (const u of await q('select id, email, name, role, is_super_admin, active from users order by id'))
    console.log(`  #${u.id} role=${u.role} super=${u.is_super_admin} email=${u.email} name="${u.name}" active=${u.active}`)
  console.log('=== NEON PERSONS ===')
  for (const p of await q('select id, user_id, name, active from persons order by id'))
    console.log(`  #${p.id} user=${p.user_id} name="${p.name}" active=${p.active}`)
  console.log('=== NEON COUNTS ===')
  const tables = ['orders','order_items','payments','customers','categories','products','modifier_groups','modifiers','product_modifier_groups','recipe_components','inventory_transactions','stock_counts','stock_count_lines','purchase_orders','purchase_order_items','suppliers','attendance','waste_logs','audit_logs','reservations','tables','floor_plans','roles','promotions','persons','users','cash_drawer_sessions','cash_drawer_entries','shifts','app_settings','vision_cameras','vision_zones','vision_events','vision_table_states','movement_candidates','hybrid_devices','hybrid_events','hybrid_conflicts','hybrid_sync_state']
  for (const t of tables) {
    try { const r = await q(`select count(*)::int c, coalesce(max(id),0)::int mx from ${t}`); console.log(`  ${t}: count=${r[0].c} max=${r[0].mx}`) } catch (e: any) { console.log(`  ${t}: ERR ${e.message.slice(0, 70)}`) }
  }
  console.log('=== NEON TABLE STATUS ===')
  for (const t of await q("select id, name, status, active from tables order by id"))
    console.log(`  T${t.id} "${t.name}" status=${t.status} active=${t.active}`)
  await pg.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
