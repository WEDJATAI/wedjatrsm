import { Pool } from 'pg'
import { neonPooledUrl } from '../lib/env-local'
const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
for (const t of ['payments','order_items','inventory_transactions','stock_counts','stock_count_lines','attendance','audit_logs','customers','hybrid_events']) {
  const c = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position", [t])
  console.log(t + ':', c.rows.map((r: { column_name: string }) => r.column_name).join(','))
}
await pool.end()
