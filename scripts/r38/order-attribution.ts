import { Pool } from 'pg'
import { neonPooledUrl } from '../lib/env-local'
import { db } from '../../src/lib/db'
const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })

const lo = await db.order.findMany({ where: { id: { in: [317, 133, 323] } }, select: { id: true, customerId: true, status: true, totalAmount: true, createdAt: true, clientName: true } })
console.log('LOCAL orders:', JSON.stringify(lo, null, 1))
const no = await pool.query('SELECT id, customer_id, status, total_amount, created_at, client_name FROM orders WHERE id IN (133,317,323) ORDER BY id')
console.log('NEON orders:', JSON.stringify(no.rows, null, 1))
await pool.end()
await db.$disconnect()
