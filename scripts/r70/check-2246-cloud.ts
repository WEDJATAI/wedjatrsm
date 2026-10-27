import { Pool } from "pg"
import { neonPooledUrl } from "../lib/env-local"
const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false } })
const o = (await pool.query("SELECT id, status, total_amount, closed_at FROM orders WHERE id = $1", [2246])).rows
console.log("NEON_ORDER_2246:", JSON.stringify(o))
const p = (await pool.query("SELECT id, method, amount, tip, reference, created_at FROM payments WHERE order_id = $1 ORDER BY id", [2246])).rows
console.log("NEON_PAYMENTS_2246:", JSON.stringify(p))
const evts = (await pool.query('SELECT id, entity, "entityId", operation, status, direction, "createdAt" FROM hybrid_events WHERE entity = $1 AND "entityId" = $2 ORDER BY id', ["Order", "2246"])).rows
console.log("NEON_ORDER_EVENTS_2246:", JSON.stringify(evts.map((e: any) => ({ id: e.id, op: e.operation, st: e.status, dir: e.direction, at: e.createdAt }))))
await pool.end()
