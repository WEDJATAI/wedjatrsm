import { Pool } from "pg"
import { neonPooledUrl } from "../lib/env-local"
const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false } })
const evts = (await pool.query('SELECT id, "entityId", operation, status, direction, "deviceId", "createdAt" FROM hybrid_events WHERE entity = $1 AND "entityId" = $2 ORDER BY id', ["Payment", 314])).rows
console.log("NEON_PAYMENT314_EVENTS:", JSON.stringify(evts))
const confl = (await pool.query('SELECT id, entity, "entityId", policy, resolution, "resolvedAt" FROM hybrid_conflicts WHERE entity = $1 AND "entityId" = $2 ORDER BY id', ["Payment", 314])).rows
console.log("NEON_PAYMENT314_CONFLICTS:", JSON.stringify(confl))
await pool.end()
