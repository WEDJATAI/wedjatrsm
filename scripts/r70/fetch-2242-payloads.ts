import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import { Pool } from "pg"
import { neonPooledUrl } from "../lib/env-local"
const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false } })
const evts = (await pool.query('SELECT id, entity, "entityId", operation, revision, payload FROM hybrid_events WHERE (entity = $1 AND "entityId" = 2242) OR (entity = $2 AND "entityId" = ANY($3)) ORDER BY id', ["Order", "Payment", [307, 308]])).rows
for (const e of evts) {
  console.log(`EVT ${e.id} ${e.entity}/${e.entityId} ${e.operation} rev${e.revision}:`)
  console.log('  ' + e.payload.slice(0, 500))
}
await pool.end()
// FK targets on the local plane
const db = new PrismaClient({ adapter: new PrismaLibSql({ url: (process.env.DATABASE_URL ?? 'file:./db/custom.db').split('?')[0] }) })
const u1 = await db.user.findUnique({ where: { id: 1 }, select: { id: true, name: true } })
console.log('LOCAL_USER_1:', JSON.stringify(u1))
await db.$disconnect()
