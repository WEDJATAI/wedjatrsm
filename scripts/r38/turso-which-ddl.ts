import { getTursoClient } from '../../src/lib/turso'
import { TURSO_DDL } from '../../src/lib/turso-schema'
const turso = getTursoClient()
let i = 0
for (const ddl of TURSO_DDL) {
  i++
  try {
    await turso.execute(ddl)
  } catch (e) {
    console.log(`FAIL #${i}: ${(e as Error).message.slice(0, 60)}`)
    console.log(`  SQL: ${ddl.slice(0, 200)}`)
  }
}
console.log('done', TURSO_DDL.length)
