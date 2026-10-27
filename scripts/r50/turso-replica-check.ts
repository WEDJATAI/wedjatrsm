// r50: Turso read-only replica freshness spot-check — the replica is the
// download/provisioning plane (DELETE+INSERT full refresh). Compare key
// table counts vs the authoritative Neon plane.
import { neonPooledUrl, tursoAuthToken, tursoDatabaseUrl } from '../lib/env-local'
import { Pool } from 'pg'

async function tursoQuery(sql: string): Promise<string[]> {
  const res = await fetch('https://' + tursoDatabaseUrl().replace(/^libsql:\/\//, '') + '/v2/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tursoAuthToken(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql } }, { type: 'close' }] }),
  })
  if (!res.ok) throw new Error(`turso HTTP ${res.status}`)
  const body = (await res.json()) as { results?: Array<{ type: string; response?: { result?: { cols?: unknown[]; rows?: Array<{ type: string; value: string }> } } }> }
  const rows = body.results?.[0]?.response?.result?.rows ?? []
  // each row is an ARRAY of column cells ({type, value}) — take the first cell
  return rows.map((r) => String(Array.isArray(r) ? r[0]?.value : (r as unknown as { value?: unknown })?.value))
}

async function main() {
  const pool = new Pool({ connectionString: neonPooledUrl(), ssl: { rejectUnauthorized: false }, max: 2 })
  // hybrid_* tables are DELIBERATELY excluded from the replica (per-installation
  // sync state — src/lib/turso-schema.ts) — probe only replicated tables.
  const tables = ['users', 'products', 'orders', 'tables']
  const appendOnlyTables = ['audit_logs'] // live-append tables: exact only right after a refresh
  let allMatch = true
  console.log('r50 Turso replica freshness —', new Date().toISOString())
  for (const t of [...tables, ...appendOnlyTables]) {
    const neonC = Number(((await pool.query(`SELECT COUNT(*)::int c FROM ${t}`)).rows[0] as { c: number }).c)
    let tursoC = -1
    try { tursoC = Number((await tursoQuery(`SELECT COUNT(*) FROM ${t}`))[0]) } catch (e) { console.log(`  ${t}: turso error ${(e as Error).message}`); allMatch = false; continue }
    const match = neonC === tursoC
    const core = !appendOnlyTables.includes(t)
    if (!match && core) allMatch = false
    console.log(`  ${t.padEnd(14)} neon=${String(neonC).padStart(6)} turso=${String(tursoC).padStart(6)} ${match ? '✓' : core ? '✗ DIFF' : `~ drift ${neonC - tursoC} rows (append-only, expected intra-day)`}`)
  }
  // replica freshness stamp (last refresh time — the daily 03:00 UTC cron)
  try {
    const stamp = (await tursoQuery('SELECT MAX(created_at) FROM audit_logs'))[0]
    console.log(`  replica audit newest row: ${stamp} (daily 03:00 UTC refresh — intra-day drift on append-only tables is expected)`)
  } catch { /* informational */ }
  await pool.end()
  console.log(allMatch
    ? 'RESULT: TURSO REPLICA IN PARITY on all replicated tables (hybrid_* excluded by design; audit lag = intra-day drift since the 03:00 UTC refresh)'
    : 'RESULT: replica drift detected on a CORE table — inspect above')
  process.exit(allMatch ? 0 : 1)
}

main().catch((e) => { console.error('FAIL:', e); process.exit(1) })
