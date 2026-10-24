import { getTursoClient } from '../../src/lib/turso'
const turso = getTursoClient()
// small write test
try {
  const r = await turso.execute("CREATE TABLE IF NOT EXISTS _r38_probe (id INTEGER PRIMARY KEY, note TEXT)")
  console.log('DDL ok:', JSON.stringify(r))
} catch (e) { console.log('DDL FAIL:', (e as Error).message) }
try {
  const r = await turso.execute("INSERT INTO _r38_probe (id, note) VALUES (1, 'r38 probe')")
  console.log('INSERT ok:', JSON.stringify(r))
} catch (e) { console.log('INSERT FAIL:', (e as Error).message) }
try {
  const r = await turso.batch([
    { sql: 'INSERT INTO _r38_probe (id, note) VALUES (2, ?)', args: ['b1'] },
    { sql: 'INSERT INTO _r38_probe (id, note) VALUES (3, ?)', args: ['b2'] },
  ])
  console.log('BATCH(2) ok:', JSON.stringify(r))
} catch (e) { console.log('BATCH(2) FAIL:', (e as Error).message) }
// larger batch
try {
  const stmts = Array.from({ length: 500 }, (_, i) => ({ sql: 'INSERT INTO _r38_probe (id, note) VALUES (?, ?)', args: [100 + i, 'bulk'] }) as never)
  const r = await turso.batch(stmts)
  console.log('BATCH(500) ok:', JSON.stringify(r).slice(0, 80))
} catch (e) { console.log('BATCH(500) FAIL:', (e as Error).message.slice(0, 120)) }
try {
  const r = await turso.execute('DROP TABLE _r38_probe')
  console.log('cleanup ok')
} catch (e) { console.log('cleanup FAIL:', (e as Error).message) }
