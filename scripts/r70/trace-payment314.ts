import { PrismaClient } from '@prisma/client'
import { PrismaLibSql } from '@prisma/adapter-libsql'
import { Pool } from "pg"
import { neonPooledUrl } from "../lib/env-local"
const db = new PrismaClient({ adapter: new PrismaLibSql({ url: (process.env.DATABASE_URL ?? 'file:./db/custom.db').split('?')[0] }) })

// LOCAL: does payment 314 exist? do its events exist?
const localPay = await db.payment.findUnique({ where: { id: 314 } })
console.log('LOCAL_PAYMENT_314:', JSON.stringify(localPay))
const localEvts = await db.hybridEvent.findMany({ where: { entity: 'Payment', entityId: '314' }, orderBy: { id: 'asc' } })
console.log('LOCAL_EVENTS_PAYMENT_314:', JSON.stringify(localEvts.map(e => ({ id: e.id, op: e.operation, dir: e.direction, st: e.status, dev: e.deviceId, err: e.lastError }))))

// What payment ids exist locally around 314?
const around = await db.payment.findMany({ where: { id: { gte: 310, lte: 330 } }, select: { id: true, orderId: true, amount: true, method: true } , orderBy: { id: 'asc' } })
console.log('LOCAL_PAYMENTS_310_330:', JSON.stringify(around))
await db.$disconnect()

const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false } })
const nEvts = (await pool.query('SELECT id, "eventId", "deviceId", operation, status, direction, "createdAt", "lastError" FROM hybrid_events WHERE entity = $1 AND "entityId" = $2 ORDER BY id', ["Payment", "314"])).rows
console.log('NEON_EVENTS_PAYMENT_314:', JSON.stringify(nEvts))
await pool.end()
