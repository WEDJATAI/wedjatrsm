import { getTursoClient } from '../../src/lib/turso'
import { TURSO_DDL, TURSO_DDL_MIGRATIONS } from '../../src/lib/turso-schema'
const turso = getTursoClient()
let i = 0
for (const ddl of TURSO_DDL) {
  i++
  try {
    await turso.execute(ddl)
  } catch (e) {
    console.log(`DDL#${i} FAIL: ${(e as Error).message.slice(0, 100)} — ${ddl.slice(0, 90)}`)
  }
}
console.log(`DDL phase done (${TURSO_DDL.length} statements)`)
for (const ddl of TURSO_DDL_MIGRATIONS) {
  try { await turso.execute(ddl) } catch { /* already exists */ }
}
console.log('migrations phase done')
// now the DELETE phase (reverse topo) — test on a harmless table
try {
  await turso.execute('DELETE FROM customers')
  console.log('DELETE customers ok — (replica will be re-synced right after)')
} catch (e) {
  console.log('DELETE customers FAIL:', (e as Error).message.slice(0, 100))
}
