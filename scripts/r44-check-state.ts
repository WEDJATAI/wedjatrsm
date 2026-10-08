/**
 * r44 — Check latest cloud updates & sync correctness (local side, read-only)
 */
import { Database } from 'bun:sqlite'

const db = new Database('/home/z/my-project/db/custom.db', { readonly: true })

function safe(label: string, sql: string) {
  try {
    console.log(label, JSON.stringify(db.query(sql).all(), null, 1))
  } catch (e) {
    console.log(label, 'ERROR:', (e as Error).message)
  }
}

const tables = db
  .query("SELECT name FROM sqlite_master WHERE type='table'")
  .all()
  .map((t: any) => t.name)
console.log('=== r44 LOCAL SYNC STATE ===')
console.log('hybrid tables:', tables.filter((t) => t.includes('hybrid')).join(', '))

safe('SYNC STATE:', 'SELECT * FROM hybrid_sync_state')

safe('OUTBOX COUNTS:', `SELECT
  (SELECT COUNT(*) FROM hybrid_events WHERE direction='out') AS totalOut,
  (SELECT COUNT(*) FROM hybrid_events WHERE direction='out' AND status='pending') AS pendingOut,
  (SELECT COUNT(*) FROM hybrid_events WHERE direction='out' AND status='failed') AS failedOut,
  (SELECT COUNT(*) FROM hybrid_events WHERE direction='in') AS totalIn`)

safe('LAST 10 OUT-EVENTS (local→cloud):', `SELECT id, streamId, tableName, recordId, status,
  datetime(createdAt/1000,'unixepoch') AS created
  FROM hybrid_events WHERE direction='out' ORDER BY id DESC LIMIT 10`)

safe('LAST 15 IN-EVENTS (cloud→local):', `SELECT id, streamId, tableName, recordId, deviceId, status,
  datetime(createdAt/1000,'unixepoch') AS created
  FROM hybrid_events WHERE direction='in' ORDER BY id DESC LIMIT 15`)

safe('LOCAL RECENT AUDIT:', 'SELECT id, action, createdAt FROM audit_logs ORDER BY id DESC LIMIT 10')
safe('LOCAL ORDERS:', 'SELECT id, status, total FROM orders ORDER BY id DESC LIMIT 5')
safe('LOCAL COUNTS:', `SELECT
  (SELECT COUNT(*) FROM users) AS users,
  (SELECT COUNT(*) FROM products) AS products,
  (SELECT COUNT(*) FROM orders) AS orders,
  (SELECT COUNT(*) FROM customers) AS customers,
  (SELECT COUNT(*) FROM audit_logs) AS audit`)

db.close()
console.log('=== END LOCAL STATE ===')
