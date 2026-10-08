import { getTursoClient } from '../../src/lib/turso'
import { TURSO_DDL, TURSO_DDL_MIGRATIONS } from '../../src/lib/turso-schema'
import { db } from '../../src/lib/db'
// replicate orderedModels minimally: import from turso-sync internals is not exported; re-derive via Prisma DMMF order used by the module — instead just test the biggest tables' batch chunks directly
const turso = getTursoClient()
for (const ddl of TURSO_DDL) { try { await turso.execute(ddl) } catch (e) { console.log('DDL FAIL', (e as Error).message.slice(0, 60)) } }
for (const ddl of TURSO_DDL_MIGRATIONS) { try { await turso.execute(ddl) } catch { /* exists */ } }
console.log('schema ok')

// test audit_logs chunk (the biggest table) — 200 rows, same shape the sync sends
const rows = await db.auditLog.findMany({ take: 200 })
const cols = ['id', 'user_id', 'user_name', 'person_id', 'person_name', 'action', 'entity', 'entity_id', 'details', 'created_at']
const stmts = rows.map((r) => {
  const x = r as unknown as Record<string, unknown>
  return {
    sql: `INSERT INTO audit_logs (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    args: [x.id, x.userId, x.userName, x.personId, x.personName, x.action, x.entity, x.entityId, x.details, x.createdAt instanceof Date ? x.createdAt.toISOString() : x.createdAt],
  }
})
try {
  await turso.execute('DELETE FROM audit_logs')
  await turso.batch(stmts as import('@libsql/client').InStatement[], 'write')
  console.log('audit_logs 200-row chunk: OK')
  const c = await turso.execute('SELECT count(*) n FROM audit_logs')
  console.log('replica audit rows now:', JSON.stringify(c.rows[0]))
} catch (e) {
  console.log('audit chunk FAIL:', (e as Error).message.slice(0, 100))
}
await db.$disconnect()
