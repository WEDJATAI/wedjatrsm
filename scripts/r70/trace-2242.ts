import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import { Pool } from "pg"
import { neonPooledUrl } from "../lib/env-local"
const db = new PrismaClient({ adapter: new PrismaLibSql({ url: (process.env.DATABASE_URL ?? 'file:./db/custom.db').split('?')[0] }) })

const lEvtOrder = await db.hybridEvent.findMany({ where: { entity: 'Order', entityId: 2242 }, select: { id: true, operation: true, direction: true, status: true, lastError: true, createdAt: true } })
console.log('LOCAL_ORDER2242_EVENTS:', JSON.stringify(lEvtOrder))
const lEvtPays = await db.hybridEvent.findMany({ where: { entity: 'Payment', entityId: { in: [307, 308] } }, select: { id: true, entityId: true, operation: true, direction: true, status: true, lastError: true } })
console.log('LOCAL_PAY307_308_EVENTS:', JSON.stringify(lEvtPays))
const lConflict = await db.hybridConflict.findMany({ where: { OR: [{ entity: 'Order', entityId: 2242 }, { entity: 'Payment', entityId: { in: [307, 308] } }] }, select: { id: true, entity: true, entityId: true, policy: true, resolution: true, details: true, resolvedAt: true } })
console.log('LOCAL_2242_CONFLICTS:', JSON.stringify(lConflict))
await db.$disconnect()

const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false } })
const nOrder = (await pool.query("SELECT id, status, total_amount, user_id, order_type, closed_at, created_at FROM orders WHERE id = 2242")).rows
console.log('NEON_ORDER2242:', JSON.stringify(nOrder))
const nPays = (await pool.query("SELECT id, order_id, method, amount, tip, reference, created_at FROM payments WHERE id IN (307,308)")).rows
console.log('NEON_PAY307_308:', JSON.stringify(nPays))
const nEvts = (await pool.query('SELECT id, entity, "entityId", operation, status, direction, "deviceId", "createdAt" FROM hybrid_events WHERE (entity = $1 AND "entityId" = 2242) OR (entity = $2 AND "entityId" = ANY($3)) ORDER BY id', ["Order", "Payment", [307, 308]])).rows
console.log('NEON_2242_EVENTS:', JSON.stringify(nEvts))
await pool.end()
